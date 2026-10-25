import type { PoolClient } from "pg";
import type { Character, LoreEvent, Relation, WorldData } from "@/lib/types";
import type { CalendarRecord, Difference, Revision, Timeline } from "@/lib/history-types";
import { GREGORIAN, gregorianYearDay, toOrdinal, validateCalendar, type CalendarDefinition } from "@/lib/calendar";
import { assertFamilyConsistent } from "@/lib/family";
import { audit, worldAccess } from "./access";
import { ApiError } from "./errors";
import { characterSchema, eventSchema, relationParticipants, relationSchema } from "./validation";
import { BASELINE_DAY, LATEST_DAY, type TemporalOptions } from "./history-validation";
import { withPortraits } from "./portraits";

type Kind = "characters" | "events" | "relations";
type Fact = Record<string, unknown>;
type StateRow = { revision: string; object_id: string; world_id: string; timeline_id: string; effective_day: string; version: number; deleted: boolean; data: Fact | null; kind: Kind; created_at: Date | string };
type Context = { world: Awaited<ReturnType<typeof worldAccess>>; timeline: Timeline };
const timelineColumns = `id,world_id AS "worldId",name,parent_id AS "parentId",parent_revision AS "parentRevision",fork_day AS "forkDay",head_revision AS "headRevision",is_main AS "isMain",is_canon AS "isCanon"`;

// Each ancestor is consulted at its pinned revision and no later than its fork
// date. Recursive SQL has no product depth cap; immutable parent links form a DAG.
const lineage = `WITH RECURSIVE lineage AS (
  SELECT id,world_id,parent_id,parent_revision,fork_day,$2::bigint AS cutoff,$3::bigint AS day,0 AS depth,ARRAY[id] AS path
  FROM timelines WHERE id=$1
  UNION ALL
  SELECT p.id,p.world_id,p.parent_id,p.parent_revision,p.fork_day,c.parent_revision,LEAST(c.day,c.fork_day),c.depth+1,c.path||p.id
  FROM lineage c JOIN timelines p ON p.id=c.parent_id AND p.world_id=c.world_id WHERE NOT p.id=ANY(c.path)
)`;

export async function initializeWorld(client: PoolClient, worldId: string) {
  await client.query("INSERT INTO timelines(world_id,name,is_main,is_canon) VALUES($1,'Основная история',true,true) ON CONFLICT(world_id) WHERE is_main DO NOTHING", [worldId]);
  await client.query("INSERT INTO world_family_state(world_id,initialized) VALUES($1,true) ON CONFLICT(world_id) DO NOTHING", [worldId]);
  await client.query("INSERT INTO world_calendars(world_id,definition,is_default) VALUES($1,$2::jsonb,true) ON CONFLICT(world_id) WHERE is_default DO NOTHING", [worldId, JSON.stringify(GREGORIAN)]);
}
async function context(client: PoolClient, userId: string, worldId: string, options: TemporalOptions = {}, write = false): Promise<Context> {
  if (write && options.revision !== undefined) throw new ApiError(400, "Нельзя изменять зафиксированную редакцию");
  const world = await worldAccess(client, userId, worldId, write);
  const found = await client.query<Timeline>(`SELECT ${timelineColumns} FROM timelines WHERE world_id=$1 AND ${options.timelineId ? "id=$2" : "is_main"}${write ? " FOR UPDATE" : ""}`, options.timelineId ? [worldId, options.timelineId] : [worldId]);
  const timeline = found.rows[0];
  if (!timeline) throw new ApiError(404, "Временная линия не найдена в этом мире");
  if (options.revision !== undefined && BigInt(options.revision) > BigInt(timeline.headRevision)) throw new ApiError(400, "Такой редакции временной линии ещё нет");
  return { world, timeline };
}
export async function timelineContext(client: PoolClient, userId: string, timelineId: string, write = false): Promise<Context> {
  const lookup = await client.query<{ world_id: string }>("SELECT world_id FROM timelines WHERE id=$1", [timelineId]);
  if (!lookup.rows[0]) throw new ApiError(404, "Временная линия не найдена");
  return context(client, userId, lookup.rows[0].world_id, { timelineId }, write);
}
async function resolve(client: PoolClient, timeline: Timeline, day = LATEST_DAY, cutoff = timeline.headRevision): Promise<StateRow[]> {
  const found = await client.query<StateRow>(`${lineage}, candidates AS (
    SELECT r.*,o.kind,c.depth FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id
    JOIN lore_objects o ON o.id=r.object_id AND o.world_id=r.world_id AND o.kind IN ('characters','events','relations')
    WHERE r.revision<=c.cutoff AND r.effective_day<=c.day
  ) SELECT DISTINCT ON(object_id) * FROM candidates ORDER BY object_id,depth,effective_day DESC,revision DESC`, [timeline.id, cutoff, day]);
  return found.rows;
}
function entity(row: StateRow): Character | LoreEvent | Relation {
  const value = { ...row.data, id: row.object_id, worldId: row.world_id, version: row.version };
  if (row.kind === "relations") return { ...value, participantIds: relationParticipants(row.data ?? {}) } as Relation;
  return value as Character | LoreEvent | Relation;
}
function publicData(rows: StateRow[], day?: string) {
  const live = rows.filter((row) => !row.deleted);
  const characters = live.filter((row) => row.kind === "characters").map((row) => entity(row) as Character).sort((a,b) => a.name.localeCompare(b.name,"ru"));
  const ids = new Set(characters.map((value) => value.id));
  const events = live.filter((row) => row.kind === "events").map((row) => entity(row) as LoreEvent).map((event) => ({ ...event, characterIds: event.characterIds.filter((id) => ids.has(id)) })).sort((a,b) => a.startYear-b.startYear || a.name.localeCompare(b.name,"ru"));
  const relations = live.filter((row) => row.kind === "relations").map((row) => entity(row) as Relation).filter((relation) => relationParticipants(relation).every((id) => ids.has(id)) && (day === undefined || active(relation,day)));
  return { characters, events, relations };
}
function active(relation: Relation, day: string) {
  const at = BigInt(day);
  const begins = relation.startYear === null ? BigInt(BASELINE_DAY) : gregorianYearDay(relation.startYear);
  const ends = relation.endYear === null ? BigInt(LATEST_DAY)+1n : toOrdinal({year:relation.endYear,month:12,day:31},GREGORIAN)+1n;
  return begins <= at && at < ends;
}
export async function listTimelines(client: PoolClient, userId: string, worldId: string) {
  await worldAccess(client,userId,worldId);
  const found = await client.query<Timeline>(`SELECT ${timelineColumns} FROM timelines WHERE world_id=$1 ORDER BY is_main DESC,created_at,id`,[worldId]);
  return found.rows;
}
export async function listCalendars(client: PoolClient, userId: string, worldId: string) {
  await worldAccess(client,userId,worldId);
  const found = await client.query<CalendarRecord>('SELECT id,world_id AS "worldId",definition,is_default AS "isDefault" FROM world_calendars WHERE world_id=$1 ORDER BY is_default DESC,created_at,id',[worldId]);
  return found.rows;
}
export async function loadWorld(client: PoolClient, userId: string, worldId: string, options: TemporalOptions = {}): Promise<WorldData> {
  const { world: scoped, timeline } = await context(client,userId,worldId,options);
  const { role, ...world } = scoped; void role;
  const rows = await resolve(client,timeline,options.day,options.revision);
  const timelines = await listTimelines(client,userId,worldId);
  const calendars = await listCalendars(client,userId,worldId);
  const data = publicData(rows,options.day);
  data.characters = await withPortraits(client, data.characters);
  return { world, ...data, history: { timeline,timelines,calendars,day:options.day ?? null } };
}
function parse(kind: Kind, value: unknown): Fact {
  const parsed = (kind === "characters" ? characterSchema.parse(value) : kind === "events" ? eventSchema.parse(value) : relationSchema.parse(value)) as Fact;
  if (kind === "events") parsed.characterIds = [...parsed.characterIds as string[]].sort();
  return parsed;
}
function writableDay(timeline: Timeline, explicit?: string, existing?: StateRow): string {
  const day = explicit ?? (existing ? existing.effective_day : timeline.forkDay ?? BASELINE_DAY);
  // A no-context update of an inherited baseline belongs at the fork, not before it.
  const result = explicit === undefined && timeline.forkDay !== null && BigInt(day)<BigInt(timeline.forkDay) ? timeline.forkDay : day;
  if (timeline.forkDay !== null && BigInt(result)<BigInt(timeline.forkDay)) throw new ApiError(400,"Правки дочерней линии не могут предшествовать дате ответвления");
  return result;
}
async function append(client: PoolClient, scoped: Context, userId: string, objectId: string, kind: Kind, day: string, value: Fact | null, before?: StateRow) {
  const version = await client.query<{version:number}>("UPDATE lore_objects SET version=version+1 WHERE id=$1 AND world_id=$2 AND kind=$3 RETURNING version",[objectId,scoped.world.id,kind]);
  if (!version.rows[0]) throw new ApiError(404,"Объект не найден");
  const saved = await client.query<StateRow>(`INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,deleted,data,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[objectId,scoped.world.id,scoped.timeline.id,day,version.rows[0].version,value===null,value===null?null:JSON.stringify(value),userId]);
  const row = {...saved.rows[0],kind};
  await client.query("UPDATE timelines SET head_revision=$1 WHERE id=$2",[row.revision,scoped.timeline.id]);
  scoped.timeline.headRevision = row.revision;
  const old = before && !before.deleted ? entity(before) : null;
  await audit(client,scoped.world.projectId,userId,kind,objectId,value===null?"delete":old?"update":"create",{timelineId:scoped.timeline.id,effectiveDay:day,revision:row.revision,...(old?{before:old}:{}),...(value===null?{}:{after:entity(row)})});
  return row;
}
async function ensureLinks(client: PoolClient, scoped: Context, day: string, kind: Kind, value: Fact) {
  const ids = kind === "events" ? value.characterIds as string[] : kind === "relations" ? relationParticipants(value) : [];
  if (!ids.length) return;
  const rows = await resolve(client,scoped.timeline,day);
  const available = new Set(rows.filter((row)=>row.kind==="characters"&&!row.deleted).map((row)=>row.object_id));
  if (ids.some((id)=>!available.has(id))) throw new ApiError(400,"Все связанные персонажи должны существовать в этом мире, линии и на выбранную дату");
}
async function breakpoints(client: PoolClient, timeline: Timeline, first: string): Promise<string[]> {
  const found = await client.query<{effective_day:string;data:Fact|null;kind:Kind}>(`${lineage} SELECT r.effective_day,r.data,o.kind FROM lineage c
    JOIN lore_revisions r ON r.timeline_id=c.id AND r.revision<=c.cutoff AND r.effective_day<=c.day JOIN lore_objects o ON o.id=r.object_id AND o.kind IN ('characters','events','relations')`,[timeline.id,timeline.headRevision,LATEST_DAY]);
  const minimum = BigInt(first), points = new Set([first]);
  for (const row of found.rows) {
    if (BigInt(row.effective_day)>=minimum) points.add(row.effective_day);
    if (row.kind!=="relations"||!row.data) continue;
    for (const field of ["startYear","endYear"] as const) {
      const year = row.data[field];
      if (typeof year!=="number") continue;
      const point = field==="endYear" ? toOrdinal({year,month:12,day:31},GREGORIAN)+1n : gregorianYearDay(year);
      if (point>=minimum && point<=BigInt(LATEST_DAY)) points.add(point.toString());
    }
  }
  return [...points].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
}
async function assertConsistent(client: PoolClient, scoped: Context, from: string) {
  for (const day of await breakpoints(client,scoped.timeline,from)) {
    const rows = await resolve(client,scoped.timeline,day);
    const live = rows.filter((row)=>!row.deleted);
    const characters = live.filter((row)=>row.kind==="characters").map((row)=>entity(row) as Character);
    const ids = new Set(characters.map((character)=>character.id));
    const relations = live.filter((row)=>row.kind==="relations").map((row)=>entity(row) as Relation);
    for (const row of live) {
      const linked = row.kind==="events" ? row.data!.characterIds as string[] : row.kind==="relations" ? relationParticipants(row.data!) : [];
      if (linked.some((id)=>!ids.has(id))) throw new ApiError(400,"Правка оставляет ссылку на отсутствующего персонажа в историческом состоянии");
    }
    try { assertFamilyConsistent(characters,relations.filter((relation)=>active(relation,day))); }
    catch(error) { throw new ApiError(400,error instanceof Error ? error.message : "Противоречие семейных связей"); }
  }
}
export async function createEntity(client: PoolClient,userId:string,worldId:string,kind:Kind,input:unknown,options:TemporalOptions={}) {
  const scoped=await context(client,userId,worldId,options,true);
  const day=writableDay(scoped.timeline,options.day), value=parse(kind,input);
  await ensureLinks(client,scoped,day,kind,value);
  const identity=await client.query<{id:string}>("INSERT INTO lore_objects(world_id,kind) VALUES($1,$2) RETURNING id",[worldId,kind]);
  const row=await append(client,scoped,userId,identity.rows[0].id,kind,day,value);
  await assertConsistent(client,scoped,day);
  return entity(row);
}
export async function mutateEntity(client:PoolClient,userId:string,kind:Kind,id:string,patch:Fact|null,options:TemporalOptions={}) {
  const lookup=await client.query<{world_id:string}>("SELECT world_id FROM lore_objects WHERE id=$1 AND kind=$2",[id,kind]);
  if(!lookup.rows[0]) throw new ApiError(404,"Объект не найден");
  const scoped=await context(client,userId,lookup.rows[0].world_id,options,true);
  const before=(await resolve(client,scoped.timeline,options.day)).find((row)=>row.object_id===id&&!row.deleted);
  if(!before) throw new ApiError(404,"Объект не найден в этой линии на выбранную дату");
  const day=writableDay(scoped.timeline,options.day,before);
  if(patch===null) {
    const points=await breakpoints(client,scoped.timeline,day);
    await append(client,scoped,userId,id,kind,day,null,before);
    if(kind==="characters") {
      // Cancel already-scheduled future resurrection and line-local references.
      // Immutable original facts remain available to previous dates and forks.
      for(const point of points) {
        const rows=await resolve(client,scoped.timeline,point);
        for(const row of rows.filter((value)=>!value.deleted)) {
          if(row.object_id===id) await append(client,scoped,userId,id,kind,point,null,row);
          else if(row.kind==="relations"&&relationParticipants(row.data!).includes(id)) {
            const participantIds = relationParticipants(row.data!).filter((participant) => participant !== id);
            const value = participantIds.length < 2 ? null : parse("relations", { ...row.data, participantIds, fromId: participantIds[0], toId: participantIds[1] });
            await append(client,scoped,userId,row.object_id,"relations",point,value,row);
          }
          else if(row.kind==="events"&&(row.data!.characterIds as string[]).includes(id)) await append(client,scoped,userId,row.object_id,"events",point,{...row.data,characterIds:(row.data!.characterIds as string[]).filter((value)=>value!==id)},row);
        }
      }
    }
    await assertConsistent(client,scoped,day);
    return {ok:true};
  }
  const {version,...changes}=patch;
  if(!Object.keys(changes).length) throw new ApiError(400,"Нет изменений для сохранения");
  if(version!==before.version) throw new ApiError(409,"Объект изменён в другом окне. Обновите данные и повторите правку");
  const combined = {...before.data,...changes};
  if (kind === "relations") {
    if (Object.hasOwn(changes,"participantIds")) {
      const participants = relationParticipants(changes);
      if (!Object.hasOwn(changes,"fromId")) combined.fromId = participants[0];
      if (!Object.hasOwn(changes,"toId")) combined.toId = participants[1];
    } else if (Object.hasOwn(changes,"fromId") || Object.hasOwn(changes,"toId")) {
      const participants = relationParticipants(before.data!);
      if (Object.hasOwn(changes,"fromId")) participants[0] = changes.fromId as string;
      if (Object.hasOwn(changes,"toId")) participants[1] = changes.toId as string;
      combined.participantIds = participants;
    }
  }
  const value=parse(kind,combined);
  await ensureLinks(client,scoped,day,kind,value);
  const saved=await append(client,scoped,userId,id,kind,day,value,before);
  await assertConsistent(client,scoped,day);
  return entity(saved);
}
export async function createTimeline(client:PoolClient,userId:string,worldId:string,input:{name:string;isCanon:boolean;parentId?:string;forkDay?:string;expectedParentRevision?:string}) {
  const world=await worldAccess(client,userId,worldId,true);
  let parent:Timeline|undefined;
  if(input.parentId) {
    parent=(await context(client,userId,worldId,{timelineId:input.parentId},true)).timeline;
    if(input.expectedParentRevision!==parent.headRevision) throw new ApiError(409,"Родительская линия изменилась. Обновите данные перед ответвлением");
    if(parent.forkDay!==null&&BigInt(input.forkDay!)<BigInt(parent.forkDay)) throw new ApiError(400,"Дата новой ветки не может предшествовать ответвлению родителя");
  }
  const result=await client.query<Timeline>(`INSERT INTO timelines(world_id,name,parent_id,parent_revision,fork_day,is_canon) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${timelineColumns}`,[worldId,input.name,parent?.id??null,parent?.headRevision??null,input.forkDay??null,input.isCanon]);
  await audit(client,world.projectId,userId,"timeline",result.rows[0].id,"create",{after:result.rows[0]});
  return result.rows[0];
}
export async function updateTimeline(client:PoolClient,userId:string,id:string,input:{name?:string;isCanon?:boolean}) {
  const scoped=await timelineContext(client,userId,id,true);
  const result=await client.query<Timeline>(`UPDATE timelines SET name=$1,is_canon=$2 WHERE id=$3 RETURNING ${timelineColumns}`,[input.name??scoped.timeline.name,input.isCanon??scoped.timeline.isCanon,id]);
  await audit(client,scoped.world.projectId,userId,"timeline",id,"update",{before:scoped.timeline,after:result.rows[0]});
  return result.rows[0];
}
export async function createCalendar(client:PoolClient,userId:string,worldId:string,definition:CalendarDefinition) {
  const world=await worldAccess(client,userId,worldId,true);
  try { validateCalendar(definition); } catch(error) { throw new ApiError(400,error instanceof Error?error.message:"Некорректный календарь"); }
  const result=await client.query<CalendarRecord>('INSERT INTO world_calendars(world_id,definition) VALUES($1,$2::jsonb) RETURNING id,world_id AS "worldId",definition,is_default AS "isDefault"',[worldId,JSON.stringify(definition)]);
  await audit(client,world.projectId,userId,"calendar",result.rows[0].id,"create",{after:result.rows[0]});
  return result.rows[0];
}
function semantic(row: StateRow): Fact | null {
  if (!row.data) return null;
  return row.kind === "relations" ? { ...row.data, participantIds: relationParticipants(row.data) } : row.data;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function compareTimelines(client:PoolClient,userId:string,leftId:string,rightId:string,day?:string):Promise<{differences:Difference[];leftRevision:string;rightRevision:string}> {
  const left=await timelineContext(client,userId,leftId);
  const right=await timelineContext(client,userId,rightId);
  if(left.world.id!==right.world.id)throw new ApiError(400,"Сравнивать можно только линии одного мира");
  const leftRows=(await resolve(client,left.timeline,day)).filter((row)=>!row.deleted),rightRows=(await resolve(client,right.timeline,day)).filter((row)=>!row.deleted);
  const a=new Map(leftRows.map((row)=>[row.object_id,row])),b=new Map(rightRows.map((row)=>[row.object_id,row]));
  const differences:Difference[]=[];
  for(const id of new Set([...a.keys(),...b.keys()])) {
    const first=a.get(id),second=b.get(id);
    if(first&&second&&canonical(semantic(first))===canonical(semantic(second)))continue;
    differences.push({id,kind:(first??second)!.kind,change:!second?"added":!first?"removed":"changed",left:first?entity(first) as unknown as Fact:null,right:second?entity(second) as unknown as Fact:null});
  }
  return {differences,leftRevision:left.timeline.headRevision,rightRevision:right.timeline.headRevision};
}
export async function transferObjects(client:PoolClient,userId:string,targetId:string,input:{sourceId:string;objectIds:string[];sourceDay?:string;targetDay?:string;expectedRevision:string;expectedSourceRevision?:string;overwrite:boolean;includeDependencies:boolean}) {
  const scoped=await timelineContext(client,userId,targetId,true);
  const source=await timelineContext(client,userId,input.sourceId);
  if(source.world.id!==scoped.world.id)throw new ApiError(400,"Перенос возможен только между линиями одного мира");
  if(source.timeline.id===scoped.timeline.id)throw new ApiError(400,"Выберите другую линию-источник");
  if(input.expectedSourceRevision!==undefined&&source.timeline.headRevision!==input.expectedSourceRevision)throw new ApiError(409,"Линия-источник изменилась после сравнения. Обновите сравнение перед переносом");
  if(scoped.timeline.headRevision!==input.expectedRevision)throw new ApiError(409,"Целевая линия изменилась. Обновите сравнение");
  // Without an explicit date, a transfer targets the latest complete frame,
  // rather than silently writing below an already-scheduled target state.
  const latestTarget=input.targetDay===undefined?await resolve(client,scoped.timeline):[];
  const latestDay=latestTarget.reduce((day,row)=>BigInt(row.effective_day)>BigInt(day)?row.effective_day:day,scoped.timeline.forkDay??BASELINE_DAY);
  const day=writableDay(scoped.timeline,input.targetDay??latestDay);
  const sourceRows=new Map((await resolve(client,source.timeline,input.sourceDay)).filter((row)=>!row.deleted).map((row)=>[row.object_id,row]));
  const selected=new Set(input.objectIds);
  for(const id of selected)if(!sourceRows.has(id))throw new ApiError(400,"Объект отсутствует в линии-источнике на выбранную дату");
  if(input.includeDependencies)for(const id of selected) {
    const row=sourceRows.get(id)!;
    const linked=row.kind==="events"?row.data!.characterIds as string[]:row.kind==="relations"?relationParticipants(row.data!):[];
    for(const dependency of linked){if(!sourceRows.has(dependency))throw new ApiError(400,"В источнике отсутствует связанный персонаж");selected.add(dependency);}
  }
  const targetRows=new Map((await resolve(client,scoped.timeline,day)).map((row)=>[row.object_id,row]));
  for(const id of selected) {
    const old=targetRows.get(id);
    if(old&&!old.deleted&&canonical(semantic(old))!==canonical(semantic(sourceRows.get(id)!))&&!input.overwrite)throw new ApiError(409,"Объект уже отличается в целевой линии. Подтвердите перезапись или выберите другие объекты");
  }
  let transferred=0;
  const ordered=[...selected].sort((a,b)=>(sourceRows.get(a)!.kind==="characters"?0:1)-(sourceRows.get(b)!.kind==="characters"?0:1));
  for(const id of ordered) {
    const row=sourceRows.get(id)!,before=targetRows.get(id);
    if(before&&!before.deleted&&canonical(semantic(before))===canonical(semantic(row)))continue;
    await ensureLinks(client,scoped,day,row.kind,row.data!);
    const saved=await append(client,scoped,userId,id,row.kind,day,parse(row.kind,row.data),before);
    targetRows.set(id,saved);transferred++;
  }
  await assertConsistent(client,scoped,day);
  return {ok:true,transferred};
}
export async function objectHistory(client:PoolClient,userId:string,kind:Kind,id:string,options:TemporalOptions={}) {
  const found=await client.query<{world_id:string}>("SELECT world_id FROM lore_objects WHERE id=$1 AND kind=$2",[id,kind]);
  if(!found.rows[0])throw new ApiError(404,"Объект не найден");
  const {timeline}=await context(client,userId,found.rows[0].world_id,options);
  const result=await client.query<StateRow>(`${lineage} SELECT r.* FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id WHERE r.object_id=$4 AND r.revision<=c.cutoff AND r.effective_day<=c.day ORDER BY r.revision DESC`,[timeline.id,options.revision??timeline.headRevision,options.day??LATEST_DAY,id]);
  if(!result.rowCount)throw new ApiError(404,"У объекта нет редакций в этой линии");
  return result.rows.map((row):Revision=>({revision:row.revision,timelineId:row.timeline_id,effectiveDay:row.effective_day,version:row.version,deleted:row.deleted,data:row.data,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at}));
}
