import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Relation } from "@/lib/types";
import type { FamilyData, FamilyEdge } from "@/lib/workspace-types";
import { assertFamilyConsistent } from "@/lib/family";
import { audit, worldAccess } from "./access";
import { getWorldCharacters } from "./catalog";
import { loadWorld } from "./history";
import { ApiError } from "./errors";

type State = { world_id: string; version: number; initialized: boolean };
type LegacySource = { timeline_id: string; timeline_name: string; source_revision: string; relations: Relation[] };
type FamilyKind = FamilyEdge["familyKind"];
type CreateInput = { fromId: string; toId: string; familyKind: FamilyKind; description?: string; expectedVersion: number };
type PatchInput = Partial<Omit<CreateInput,"expectedVersion">> & { version: number; expectedVersion: number };
const edgeColumns = 'id,world_id AS "worldId",from_id AS "fromId",to_id AS "toId",family_kind AS "familyKind",description,version';
const editors = new Set(["owner", "admin", "editor"]);
const labels: Record<FamilyKind,string> = { parent: "Родитель", adoptive_parent: "Усыновление", spouse: "Брак" };

function relation(edge: FamilyEdge): Relation {
  return { ...edge, participantIds: [edge.fromId,edge.toId], kind: labels[edge.familyKind], mutual: edge.familyKind === "spouse", startYear: null, endYear: null };
}
function legacyEdge(value: Relation, worldId: string): FamilyEdge {
  return { id: value.id, worldId, fromId: value.fromId, toId: value.toId, familyKind: value.familyKind as FamilyKind,
    description: value.description ?? "", version: value.version || 1 };
}
async function readState(client: PoolClient, worldId: string, lock = false): Promise<State> {
  const result = await client.query<State>(`SELECT world_id,version,initialized FROM world_family_state WHERE world_id=$1${lock ? " FOR UPDATE" : ""}`, [worldId]);
  if (!result.rows[0]) throw new ApiError(503, "Необходимо применить миграции семейного древа");
  return result.rows[0];
}
async function edges(client: PoolClient, worldId: string) {
  return (await client.query<FamilyEdge>(`SELECT ${edgeColumns} FROM family_relations WHERE world_id=$1 ORDER BY id`, [worldId])).rows;
}
async function sources(client: PoolClient, worldId: string) {
  return (await client.query<LegacySource>(`SELECT l.timeline_id,l.timeline_name,l.source_revision,l.relations FROM family_legacy_sources l
    JOIN timelines t ON t.id=l.timeline_id AND t.world_id=l.world_id WHERE l.world_id=$1 ORDER BY t.is_main DESC,t.created_at,t.id`, [worldId])).rows;
}
function signature(values: FamilyEdge[]): string {
  return JSON.stringify(values.map((edge) => {
    const pair = edge.familyKind === "spouse" ? [edge.fromId,edge.toId].sort() : [edge.fromId,edge.toId];
    return JSON.stringify([edge.familyKind,...pair,edge.description]);
  }).sort());
}
async function validate(client: PoolClient, userId: string, worldId: string, values: FamilyEdge[]) {
  const characters = await getWorldCharacters(client,userId,worldId);
  try { assertFamilyConsistent(characters,values.map(relation)); }
  catch (error) { throw new ApiError(400,error instanceof Error ? error.message : "Противоречие семейных связей"); }
}
async function install(client: PoolClient, userId: string, worldId: string, values: FamilyEdge[], source: LegacySource | null) {
  await validate(client,userId,worldId,values);
  for (const value of values) {
    await client.query(`INSERT INTO family_relations(id,world_id,from_id,to_id,family_kind,description,version,source_relation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [value.id,worldId,value.fromId,value.toId,value.familyKind,value.description,value.version,source ? value.id : null]);
  }
  await client.query("UPDATE world_family_state SET initialized=true,version=version+1,updated_at=now() WHERE world_id=$1", [worldId]);
  const world = await worldAccess(client,userId,worldId);
  await audit(client,world.projectId,userId,"family_import",worldId,"create",{sourceTimelineId:source?.timeline_id ?? null,sourceRevision:source?.source_revision ?? null,relations:values.map(relation)});
}
async function autoInitialize(client: PoolClient, userId: string, worldId: string, state: State) {
  if (state.initialized) return state;
  const legacy = await sources(client,worldId);
  const candidates = legacy.map((source) => source.relations.map((value) => legacyEdge(value,worldId)));
  if (candidates.length && !candidates.every((candidate) => signature(candidate) === signature(candidates[0]))) return state;
  const values = candidates[0] ?? [];
  try { await validate(client,userId,worldId,values); }
  catch (error) { if (error instanceof ApiError && error.status === 400) return state; throw error; }
  await install(client,userId,worldId,values,legacy[0] ?? null);
  return readState(client,worldId,true);
}
async function data(client: PoolClient, userId: string, worldId: string, state: State): Promise<FamilyData> {
  const characters = await getWorldCharacters(client,userId,worldId);
  const relations = (await edges(client,worldId)).map(relation);
  const legacy = state.initialized ? [] : await sources(client,worldId);
  return { characters,relations,version:state.version,migration:state.initialized ? null : {
    required:true,sources:legacy.map((source) => ({timelineId:source.timeline_id,name:source.timeline_name,count:source.relations.length})),
    message:"В прежних линиях сохранены разные или несовместимые семейные состояния. Выберите исходную линию для общего древа; прежняя история сохранится.",
  } };
}
async function writable(client: PoolClient, userId: string, worldId: string, expectedVersion: number) {
  const world = await worldAccess(client,userId,worldId,true);
  let state = await readState(client,worldId,true);
  state = await autoInitialize(client,userId,worldId,state);
  if (!state.initialized) throw new ApiError(409,"Сначала выберите исходную семейную версию для общего древа");
  if (state.version !== expectedVersion) throw new ApiError(409,"Семейное древо изменилось. Обновите данные и повторите действие");
  return world;
}
async function bump(client: PoolClient, worldId: string) {
  await client.query("UPDATE world_family_state SET version=version+1,updated_at=now() WHERE world_id=$1", [worldId]);
}
export async function getFamily(client: PoolClient, userId: string, worldId: string): Promise<FamilyData> {
  const world = await worldAccess(client,userId,worldId);
  let state = await readState(client,worldId);
  if (!state.initialized && editors.has(world.role)) {
    await worldAccess(client,userId,worldId,true);
    state = await autoInitialize(client,userId,worldId,await readState(client,worldId,true));
  }
  return data(client,userId,worldId,state);
}
export async function createFamilyEdge(client: PoolClient, userId: string, worldId: string, input: CreateInput): Promise<FamilyData> {
  const world = await writable(client,userId,worldId,input.expectedVersion);
  const next: FamilyEdge = {id:randomUUID(),worldId,fromId:input.fromId,toId:input.toId,familyKind:input.familyKind,description:input.description ?? "",version:1};
  await validate(client,userId,worldId,[...await edges(client,worldId),next]);
  await client.query("INSERT INTO family_relations(id,world_id,from_id,to_id,family_kind,description) VALUES($1,$2,$3,$4,$5,$6)", [next.id,worldId,next.fromId,next.toId,next.familyKind,next.description]);
  await bump(client,worldId);
  await audit(client,world.projectId,userId,"family_relation",next.id,"create",{after:next});
  return data(client,userId,worldId,await readState(client,worldId));
}
async function locate(client: PoolClient, userId: string, edgeId: string, expectedVersion: number) {
  const found = await client.query<{world_id:string}>("SELECT world_id FROM family_relations WHERE id=$1",[edgeId]);
  if (!found.rows[0]) throw new ApiError(404,"Родственная связь не найдена");
  const worldId = found.rows[0].world_id;
  const world = await writable(client,userId,worldId,expectedVersion);
  const edge = (await client.query<FamilyEdge>(`SELECT ${edgeColumns} FROM family_relations WHERE id=$1 FOR UPDATE`,[edgeId])).rows[0];
  if (!edge) throw new ApiError(404,"Родственная связь не найдена");
  return {worldId,world,edge};
}
export async function updateFamilyEdge(client: PoolClient, userId: string, edgeId: string, input: PatchInput): Promise<FamilyData> {
  const {worldId,world,edge} = await locate(client,userId,edgeId,input.expectedVersion);
  if (edge.version !== input.version) throw new ApiError(409,"Родственная связь изменена в другом окне");
  const next: FamilyEdge = {...edge,fromId:input.fromId ?? edge.fromId,toId:input.toId ?? edge.toId,familyKind:input.familyKind ?? edge.familyKind,description:input.description ?? edge.description,version:edge.version+1};
  await validate(client,userId,worldId,(await edges(client,worldId)).map((value) => value.id === edgeId ? next : value));
  await client.query("UPDATE family_relations SET from_id=$1,to_id=$2,family_kind=$3,description=$4,version=version+1 WHERE id=$5", [next.fromId,next.toId,next.familyKind,next.description,edgeId]);
  await bump(client,worldId);
  await audit(client,world.projectId,userId,"family_relation",edgeId,"update",{before:edge,after:next});
  return data(client,userId,worldId,await readState(client,worldId));
}
export async function deleteFamilyEdge(client: PoolClient, userId: string, edgeId: string, expectedVersion: number): Promise<FamilyData> {
  const {worldId,world,edge} = await locate(client,userId,edgeId,expectedVersion);
  await client.query("DELETE FROM family_relations WHERE id=$1",[edgeId]);
  await bump(client,worldId);
  await audit(client,world.projectId,userId,"family_relation",edgeId,"delete",{before:edge});
  return data(client,userId,worldId,await readState(client,worldId));
}
export async function importFamily(client: PoolClient, userId: string, worldId: string, input: {timelineId:string;day?:string;expectedVersion:number}): Promise<FamilyData> {
  await worldAccess(client,userId,worldId,true);
  const state = await readState(client,worldId,true);
  if (state.initialized) throw new ApiError(409,"Общее семейное древо уже настроено");
  if (state.version !== input.expectedVersion) throw new ApiError(409,"Состояние переноса изменилось. Обновите данные");
  const legacy = (await sources(client,worldId)).find((source) => source.timeline_id === input.timelineId);
  if (!legacy) throw new ApiError(404,"Исходная семейная версия не найдена в этом мире");
  const values = input.day === undefined ? legacy.relations : (await loadWorld(client,userId,worldId,{timelineId:legacy.timeline_id,day:input.day,revision:legacy.source_revision})).relations;
  const chosen = values.filter((value) => value.familyKind && value.familyKind !== "other").map((value) => legacyEdge(value,worldId));
  await install(client,userId,worldId,chosen,legacy);
  return data(client,userId,worldId,await readState(client,worldId));
}
