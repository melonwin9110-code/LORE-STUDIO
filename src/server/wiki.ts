import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Revision, Timeline } from "@/lib/history-types";
import { GEOGRAPHY_TYPES, type GeographyKind } from "@/lib/map-types";
import type { WikiArticle, WikiArticleInput, WikiEntry, WikiFact, WikiFilters, WikiHistory, WikiIndex, WikiPage, WikiSourceKind } from "@/lib/wiki-types";
import { wikiDocumentEmbeds, wikiDocumentImages, wikiDocumentReferences, wikiDocumentText } from "@/lib/wiki-document";
import { audit, worldAccess } from "./access";
import { ApiError } from "./errors";
import { BASELINE_DAY, LATEST_DAY, type TemporalOptions } from "./history-validation";
import { wikiCreateSchema, wikiFiltersSchema, wikiPatchSchema } from "./wiki-validation";

type Fact = Record<string, unknown>;
type RawKind = WikiSourceKind | "map_layers" | "wiki_articles";
type Row = { object_id: string; world_id: string; timeline_id: string; revision: string; effective_day: string; version: number; deleted: boolean; kind: RawKind; data: Fact | null; created_at: Date | string };
type Scope = { world: Awaited<ReturnType<typeof worldAccess>>; timeline: Timeline };
type Snapshot = { scoped: Scope; rows: Row[]; entries: WikiEntry[]; visible: Map<string, Row>; revision: string };
type ArticlePatch = Partial<WikiArticleInput> & { version: number };
const MAX_ENTRIES = 10_000;
const sourceKinds = new Set<RawKind>(["characters", "events", "maps", "map_features"]);
const sourceCategories: Record<WikiSourceKind, string> = { characters: "Персонажи", events: "События", maps: "Карты", map_features: "География" };
const timelineColumns = `id,world_id AS "worldId",name,parent_id AS "parentId",parent_revision AS "parentRevision",fork_day AS "forkDay",head_revision AS "headRevision",is_main AS "isMain",is_canon AS "isCanon"`;

// Every ancestor contributes only its pinned revision and its fork date. Search,
// links, automatic cards and author-written text all use this same snapshot.
const lineage = `WITH RECURSIVE lineage AS (
  SELECT id,world_id,parent_id,parent_revision,fork_day,$2::bigint AS cutoff,$3::bigint AS day,0 AS depth,ARRAY[id] AS path
  FROM timelines WHERE id=$1
  UNION ALL
  SELECT p.id,p.world_id,p.parent_id,p.parent_revision,p.fork_day,c.parent_revision,LEAST(c.day,c.fork_day),c.depth+1,c.path||p.id
  FROM lineage c JOIN timelines p ON p.id=c.parent_id AND p.world_id=c.world_id WHERE NOT p.id=ANY(c.path)
)`;

async function context(client: PoolClient, userId: string, worldId: string, options: TemporalOptions, write = false): Promise<Scope> {
  if (write && options.revision !== undefined) throw new ApiError(400, "Нельзя изменять зафиксированную редакцию");
  const world = await worldAccess(client, userId, worldId, write);
  const result = await client.query<Timeline>(`SELECT ${timelineColumns} FROM timelines WHERE world_id=$1 AND ${options.timelineId ? "id=$2" : "is_main"}${write ? " FOR UPDATE" : ""}`, options.timelineId ? [worldId, options.timelineId] : [worldId]);
  const timeline = result.rows[0];
  if (!timeline) throw new ApiError(404, "Временная линия не найдена в этом мире");
  if (options.revision !== undefined && BigInt(options.revision) > BigInt(timeline.headRevision)) throw new ApiError(400, "Такой редакции временной линии ещё нет");
  if (write && options.day !== undefined && timeline.forkDay !== null && BigInt(options.day) < BigInt(timeline.forkDay)) throw new ApiError(400, "Правки дочерней линии не могут предшествовать дате ответвления");
  return { world, timeline };
}

async function resolve(client: PoolClient, timeline: Timeline, day = LATEST_DAY, cutoff = timeline.headRevision): Promise<Row[]> {
  const result = await client.query<Row>(`${lineage}, candidates AS (
    SELECT r.object_id,r.world_id,r.timeline_id,r.revision,r.effective_day,r.version,r.deleted,r.data,r.created_at,o.kind,c.depth
    FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id
    JOIN lore_objects o ON o.id=r.object_id AND o.world_id=r.world_id
    WHERE r.revision<=c.cutoff AND r.effective_day<=c.day
      AND o.kind IN ('characters','events','maps','map_layers','map_features','wiki_articles')
  ) SELECT DISTINCT ON(object_id) * FROM candidates ORDER BY object_id,depth,effective_day DESC,revision DESC`, [timeline.id, cutoff, day]);
  return result.rows;
}

function text(value: unknown): string { return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function byTitle(a: WikiEntry, b: WikiEntry) { return a.title.localeCompare(b.title, "ru") || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id); }
function article(row: Row): WikiArticle {
  const data = row.data!;
  return { id: row.object_id, worldId: row.world_id, version: row.version, title: text(data.title), summary: text(data.summary), document: data.document as WikiArticleInput["document"], category: text(data.category), tags: strings(data.tags), knowledge: data.knowledge as WikiArticleInput["knowledge"], sourceId: data.sourceId as string | null };
}
function entry(row: Row): WikiEntry {
  const data = row.data!;
  if (row.kind === "wiki_articles") {
    const value = article(row);
    return { id: row.object_id, kind: "articles", title: value.title, summary: value.summary || wikiDocumentText(value.document).slice(0, 240), category: value.category, tags: value.tags, knowledge: value.knowledge, hasArticle: true };
  }
  const kind = row.kind as WikiSourceKind;
  return { id: row.object_id, kind, title: text(data.name), summary: text(data.description) || text(data.biography) || text(data.title), category: sourceCategories[kind], tags: [], knowledge: "fact", hasArticle: false };
}

function snapshot(scoped: Scope, rows: Row[], options: TemporalOptions): Snapshot {
  const live = rows.filter((row) => !row.deleted);
  const maps = new Set(live.filter((row) => row.kind === "maps").map((row) => row.object_id));
  const visibleRows = live.filter((row) => row.kind !== "map_layers" && (row.kind !== "map_features" || maps.has(text(row.data!.mapId))));
  const visible = new Map(visibleRows.map((row) => [row.object_id, row]));
  return { scoped, rows, visible, entries: visibleRows.map(entry).sort(byTitle), revision: options.revision ?? scoped.timeline.headRevision };
}

async function load(client: PoolClient, userId: string, worldId: string, options: TemporalOptions, write = false) {
  const scoped = await context(client, userId, worldId, options, write);
  return snapshot(scoped, await resolve(client, scoped.timeline, options.day, options.revision), options);
}

function searchText(row: Row) {
  if (row.kind === "wiki_articles") return text(row.data!.searchText);
  return Object.entries(row.data!).filter(([key, value]) => typeof value === "string" && !["layerId", "mapId", "parentId", "eventId", "fill", "stroke"].includes(key)).map(([, value]) => value).join(" ");
}

/** Full-text matching happens after temporal resolution, never before it. */
export async function listWiki(client: PoolClient, userId: string, worldId: string, filters: WikiFilters = {}, options: TemporalOptions = {}): Promise<WikiIndex> {
  const selected = wikiFiltersSchema.parse(filters);
  const current = await load(client, userId, worldId, options);
  const categories = [...new Set(current.entries.map((value) => value.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const tags = [...new Set(current.entries.flatMap((value) => value.tags))].sort((a, b) => a.localeCompare(b, "ru"));
  let entries = current.entries.filter((value) => (selected.category === undefined || value.category === selected.category) &&
    (selected.tag === undefined || value.tags.includes(selected.tag)) && (!selected.kind || value.kind === selected.kind) && (!selected.knowledge || value.knowledge === selected.knowledge));
  if (selected.query) {
    const candidates = entries.map((value) => ({ id: value.id, title: value.title, text: searchText(current.visible.get(value.id)!) }));
    const found = await client.query<{ id: string; rank: number }>(`WITH input AS (
      SELECT id,title,text,to_tsvector('russian',text) AS document,plainto_tsquery('russian',$2) AS query
      FROM jsonb_to_recordset($1::jsonb) AS item(id text,title text,text text)
    ) SELECT id,ts_rank_cd(document,query)+CASE WHEN strpos(lower(title),lower($2))>0 THEN 1 ELSE 0 END AS rank
      FROM input WHERE document@@query OR strpos(lower(title),lower($2))>0 ORDER BY rank DESC,id`, [JSON.stringify(candidates), selected.query]);
    const ranks = new Map(found.rows.map((row) => [row.id, row.rank]));
    entries = entries.filter((value) => ranks.has(value.id)).sort((a, b) => ranks.get(b.id)! - ranks.get(a.id)! || byTitle(a, b));
  }
  if (entries.length > MAX_ENTRIES) throw new ApiError(413, "Слишком много материалов. Уточните поиск или фильтры энциклопедии");
  return { entries, categories, tags, revision: current.revision };
}

function factsFor(row: Row, current: Snapshot): WikiFact[] {
  const data = row.data!;
  const facts: WikiFact[] = [];
  const add = (label: string, value: unknown) => { const rendered = text(value); if (rendered) facts.push({ label, value: rendered }); };
  const names = (ids: string[]) => ids.map((id) => current.visible.get(id)).filter((value): value is Row => Boolean(value)).map((value) => text(value.data!.name) || text(value.data!.title)).join(", ");
  if (row.kind === "characters") {
    add("Имя", data.name); add("Титул", data.title); add("Вид", data.species); add("Пол", data.gender);
    add("Год рождения", data.birthYear); add("Год смерти", data.deathYear); add("Внешность", data.appearance);
    add("Характер", data.personality); add("Биография", data.biography); add("Мотивация", data.motivation);
    add("Способности", data.abilities); add("Тайны персонажа", data.secrets); add("Статус", data.status === "canon" ? "Канон" : "Черновик");
  } else if (row.kind === "events") {
    add("Название", data.name); add("Тип", data.type); add("Начальный год", data.startYear); add("Конечный год", data.endYear);
    add("Описание", data.description); add("Участники", names(strings(data.characterIds))); add("Статус", data.status === "canon" ? "Канон" : "Черновик");
  } else if (row.kind === "maps") {
    add("Название", data.name); add("Описание", data.description); add("Размеры", `${text(data.width)} × ${text(data.height)}`);
    if (data.generation && typeof data.generation === "object") add("Код мира", (data.generation as Fact).seed);
  } else if (row.kind === "map_features") {
    add("Название", data.name); add("Тип", GEOGRAPHY_TYPES[data.kind as GeographyKind]); add("Описание", data.description);
    add("Карта", names([text(data.mapId)])); add("Территория", names([text(data.parentId)])); add("Событие", names([text(data.eventId)]));
  }
  return facts;
}

function relatedTo(row: Row, current: Snapshot) {
  const ids = new Set<string>();
  const data = row.data!;
  if (row.kind === "wiki_articles" && data.sourceId) ids.add(text(data.sourceId));
  for (const candidate of current.visible.values()) {
    if (candidate.kind === "wiki_articles" && candidate.data!.sourceId === row.object_id) ids.add(candidate.object_id);
    if (row.kind === "characters" && candidate.kind === "events" && strings(candidate.data!.characterIds).includes(row.object_id)) ids.add(candidate.object_id);
    if (row.kind === "maps" && candidate.kind === "map_features" && candidate.data!.mapId === row.object_id) ids.add(candidate.object_id);
  }
  if (row.kind === "events") for (const id of strings(data.characterIds)) ids.add(id);
  if (row.kind === "map_features") for (const id of [data.mapId, data.parentId, data.eventId]) if (typeof id === "string") ids.add(id);
  if (row.kind === "wiki_articles") for (const id of wikiDocumentReferences(article(row).document)) ids.add(id);
  ids.delete(row.object_id);
  return current.entries.filter((value) => ids.has(value.id));
}

async function page(client: PoolClient, id: string, current: Snapshot): Promise<WikiPage> {
  const row = current.visible.get(id);
  if (!row) throw new ApiError(404, "Материал недоступен в этой линии на выбранную дату");
  if (current.entries.length > MAX_ENTRIES) throw new ApiError(413, "Слишком много объектов для энциклопедии этого мира");
  const body = row.kind === "wiki_articles" ? article(row) : null;
  const source = body ? body.sourceId ? current.visible.get(body.sourceId) : undefined : row;
  const facts = source ? factsFor(source, current) : body?.sourceId ? [{ label: "Связанный объект", value: "Объект недоступен" }] : [];
  if (source?.kind === "characters") {
    const portrait = await client.query<{ portrait_version: number }>("SELECT o.portrait_version FROM character_portraits p JOIN lore_objects o ON o.id=p.character_id WHERE p.character_id=$1 AND p.world_id=$2", [source.object_id, current.scoped.world.id]);
    if (portrait.rows[0]) facts.push({ label: "Портрет", value: `/api/characters/${source.object_id}/portrait?v=${portrait.rows[0].portrait_version}` });
  }
  const backlinkIds = new Set([...current.visible.values()].filter((candidate) => candidate.kind === "wiki_articles" && wikiDocumentReferences(article(candidate).document).includes(id)).map((candidate) => candidate.object_id));
  return { entry: entry(row), article: body, facts, backlinks: current.entries.filter((value) => backlinkIds.has(value.id)), related: relatedTo(row, current), targets: current.entries, revision: current.revision };
}

export async function getWikiPage(client: PoolClient, userId: string, worldId: string, entryId: string, options: TemporalOptions = {}): Promise<WikiPage> {
  return page(client, entryId, await load(client, userId, worldId, options));
}

function writableDay(timeline: Timeline, explicit?: string, existing = BASELINE_DAY) {
  const day = explicit ?? (timeline.forkDay !== null && BigInt(existing) < BigInt(timeline.forkDay) ? timeline.forkDay : existing);
  if (timeline.forkDay !== null && BigInt(day) < BigInt(timeline.forkDay)) throw new ApiError(400, "Правки дочерней линии не могут предшествовать дате ответвления");
  return day;
}

function articleDay(current: Snapshot, input: WikiArticleInput, explicit?: string, before?: Row) {
  let day = writableDay(current.scoped.timeline, explicit, before?.effective_day);
  if (explicit !== undefined) return day;
  const old = before && !before.deleted ? article(before) : null;
  const previous = new Set(old ? wikiDocumentReferences(old.document) : []);
  const additions = wikiDocumentReferences(input.document).filter((id) => !previous.has(id));
  if (input.sourceId !== null && input.sourceId !== old?.sourceId) additions.push(input.sourceId);
  // In the latest-state UI, a newly selected target may have been created at a
  // later historical day. Place the note no earlier than that target's visible
  // state, while preserving the day of unchanged archived references.
  for (const id of additions) {
    const target = current.visible.get(id);
    if (target && BigInt(target.effective_day) > BigInt(day)) day = target.effective_day;
  }
  return day;
}

async function articleScope(client: PoolClient, userId: string, id: string, options: TemporalOptions, write = false) {
  const identity = await client.query<{ world_id: string }>("SELECT world_id FROM lore_objects WHERE id=$1 AND kind='wiki_articles'", [id]);
  if (!identity.rows[0]) throw new ApiError(404, "Статья не найдена");
  return load(client, userId, identity.rows[0].world_id, options, write);
}

async function validateReferences(client: PoolClient, current: Snapshot, input: WikiArticleInput, before?: Row) {
  const old = before && !before.deleted ? article(before) : null;
  const previous = new Set(old ? wikiDocumentReferences(old.document) : []);
  for (const id of wikiDocumentReferences(input.document)) if (!current.visible.has(id) && !previous.has(id)) throw new ApiError(400, "Ссылка должна вести на доступный материал этого мира, линии и даты");
  if (input.sourceId !== null && input.sourceId !== old?.sourceId) {
    const source = current.visible.get(input.sourceId);
    if (!source || !sourceKinds.has(source.kind)) throw new ApiError(400, "Связанный объект должен существовать в этом мире, линии и на выбранную дату");
  }
  const oldEmbeds = new Set(old ? wikiDocumentEmbeds(old.document).map((value) => `${value.kind}:${value.targetId}`) : []);
  for (const embed of wikiDocumentEmbeds(input.document)) {
    const target = current.visible.get(embed.targetId);
    if (!target && oldEmbeds.has(`${embed.kind}:${embed.targetId}`)) continue;
    if (target?.kind !== (embed.kind === "characterCard" ? "characters" : "maps")) throw new ApiError(400, embed.kind === "characterCard" ? "Встроенная карточка должна ссылаться на персонажа этого мира" : "Встроенная карта должна ссылаться на карту этого мира");
  }
  const images = [...new Set(wikiDocumentImages(input.document))];
  if (images.length) {
    const found = await client.query<{ id: string }>("SELECT id FROM wiki_images WHERE world_id=$1 AND id=ANY($2::uuid[])", [current.scoped.world.id, images]);
    if (found.rows.length !== images.length) throw new ApiError(400, "Изображения статьи должны принадлежать этому миру");
  }
}

function stored(input: WikiArticleInput): Fact {
  return { ...input, searchText: [input.title, input.summary, wikiDocumentText(input.document), input.category, ...input.tags].join(" ") };
}

async function append(client: PoolClient, userId: string, current: Snapshot, id: string, day: string, input: WikiArticleInput | null, before?: Row) {
  const counter = await client.query<{ version: number }>("UPDATE lore_objects SET version=version+1 WHERE id=$1 AND world_id=$2 AND kind='wiki_articles' RETURNING version", [id, current.scoped.world.id]);
  if (!counter.rows[0]) throw new ApiError(404, "Статья не найдена");
  const result = await client.query<Row>(`INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,deleted,data,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`, [id, current.scoped.world.id, current.scoped.timeline.id, day, counter.rows[0].version, input === null, input === null ? null : JSON.stringify(stored(input)), userId]);
  const row = { ...result.rows[0], kind: "wiki_articles" as const };
  await client.query("UPDATE timelines SET head_revision=$1 WHERE id=$2", [row.revision, current.scoped.timeline.id]);
  current.scoped.timeline.headRevision = row.revision;
  await audit(client, current.scoped.world.projectId, userId, "wiki_articles", id, input === null ? "delete" : before && !before.deleted ? "update" : "create", { timelineId: current.scoped.timeline.id, effectiveDay: day, revision: row.revision, ...(before && !before.deleted ? { before: article(before) } : {}), ...(input ? { after: article(row) } : {}) });
}

export async function createWikiArticle(client: PoolClient, userId: string, worldId: string, input: WikiArticleInput, options: TemporalOptions = {}): Promise<WikiPage> {
  const value = wikiCreateSchema.parse(input);
  const current = await load(client, userId, worldId, options, true);
  await validateReferences(client, current, value);
  const day = articleDay(current, value, options.day);
  const at = snapshot(current.scoped, await resolve(client, current.scoped.timeline, day), { ...options, day });
  await validateReferences(client, at, value);
  const id = randomUUID();
  await client.query("INSERT INTO lore_objects(id,world_id,kind) VALUES($1,$2,'wiki_articles')", [id, worldId]);
  await append(client, userId, current, id, day, value);
  return getWikiPage(client, userId, worldId, id, options);
}

export async function updateWikiArticle(client: PoolClient, userId: string, id: string, input: ArticlePatch, options: TemporalOptions = {}): Promise<WikiPage> {
  const { version, ...patch } = wikiPatchSchema.parse(input);
  const current = await articleScope(client, userId, id, options, true);
  const before = current.visible.get(id);
  if (!before) throw new ApiError(404, "Статья не найдена в этой линии на выбранную дату");
  if (before.version !== version) throw new ApiError(409, "Статья уже изменена. Перечитайте сохранённую версию; ваш черновик можно сохранить отдельно");
  const previous = article(before);
  const value = wikiCreateSchema.parse({ title: previous.title, summary: previous.summary, document: previous.document, category: previous.category, tags: previous.tags, knowledge: previous.knowledge, sourceId: previous.sourceId, ...patch });
  await validateReferences(client, current, value, before);
  const day = articleDay(current, value, options.day, before);
  const at = snapshot(current.scoped, await resolve(client, current.scoped.timeline, day), { ...options, day });
  await validateReferences(client, at, value, before);
  await append(client, userId, current, id, day, value, before);
  return getWikiPage(client, userId, current.scoped.world.id, id, options);
}

export async function deleteWikiArticle(client: PoolClient, userId: string, id: string, version: number, options: TemporalOptions = {}) {
  const current = await articleScope(client, userId, id, options, true);
  const before = current.visible.get(id);
  if (!before) throw new ApiError(404, "Статья не найдена в этой линии на выбранную дату");
  if (before.version !== version) throw new ApiError(409, "Статья уже изменена. Перечитайте данные перед удалением");
  await append(client, userId, current, id, writableDay(current.scoped.timeline, options.day, before.effective_day), null, before);
  return { ok: true };
}

export async function wikiArticleHistory(client: PoolClient, userId: string, id: string, options: TemporalOptions = {}): Promise<WikiHistory> {
  const current = await articleScope(client, userId, id, options);
  const found = await client.query<Row>(`${lineage} SELECT r.* FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id
    WHERE r.object_id=$4 AND r.revision<=c.cutoff AND r.effective_day<=c.day ORDER BY r.revision DESC`, [current.scoped.timeline.id, options.revision ?? current.scoped.timeline.headRevision, options.day ?? LATEST_DAY, id]);
  if (!found.rows.length) throw new ApiError(404, "История статьи недоступна в этой линии на выбранную дату");
  const revisions: Revision[] = found.rows.map((row) => ({ revision: row.revision, timelineId: row.timeline_id, effectiveDay: row.effective_day, version: row.version, deleted: row.deleted, data: row.data === null ? null : { ...article({ ...row, kind: "wiki_articles" }) }, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }));
  return { revisions };
}
