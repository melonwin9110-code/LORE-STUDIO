import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Revision, Timeline } from "@/lib/history-types";
import type { AtlasMap, MapBatchInput, MapData, MapFeature, MapFeatureInput, MapFeatureHistory, MapGeometry, MapInput, MapLayer, MapLayerInput } from "@/lib/map-types";
import { audit, worldAccess } from "./access";
import { ApiError } from "./errors";
import { BASELINE_DAY, LATEST_DAY, type TemporalOptions } from "./history-validation";
import { countGeometryVertices, geometrySchema, mapBatchSchema, mapCreateSchema, mapMergeSchema, mapPatchSchema, mapSplitSchema } from "./map-validation";

type MapKind = "maps" | "map_layers" | "map_features";
type Fact = Record<string, unknown>;
type Row = { object_id: string; world_id: string; timeline_id: string; revision: string; effective_day: string; version: number; deleted: boolean; kind: MapKind | "events"; data: Fact | null; created_at: Date | string };
type Scope = { world: Awaited<ReturnType<typeof worldAccess>>; timeline: Timeline };
type MapPatch = { version: number; name?: string; description?: string; background?: string };
type PolygonGeometry = Extract<MapGeometry, { type: "Polygon" | "MultiPolygon" }>;
const timelineColumns = `id,world_id AS "worldId",name,parent_id AS "parentId",parent_revision AS "parentRevision",fork_day AS "forkDay",head_revision AS "headRevision",is_main AS "isMain",is_canon AS "isCanon"`;

// The same shared revision sequence and ancestor pins as ordinary lore facts.
// Map editing can never advance a frozen parent's contribution to a branch.
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
  const found = await client.query<Timeline>(`SELECT ${timelineColumns} FROM timelines WHERE world_id=$1 AND ${options.timelineId ? "id=$2" : "is_main"}${write ? " FOR UPDATE" : ""}`, options.timelineId ? [worldId, options.timelineId] : [worldId]);
  const timeline = found.rows[0];
  if (!timeline) throw new ApiError(404, "Временная линия не найдена в этом мире");
  if (options.revision !== undefined && BigInt(options.revision) > BigInt(timeline.headRevision)) throw new ApiError(400, "Такой редакции временной линии ещё нет");
  if (write && options.day !== undefined && timeline.forkDay !== null && BigInt(options.day) < BigInt(timeline.forkDay)) throw new ApiError(400, "Правки дочерней линии не могут предшествовать дате ответвления");
  return { world, timeline };
}

async function resolve(client: PoolClient, timeline: Timeline, day = LATEST_DAY, cutoff = timeline.headRevision): Promise<Row[]> {
  const found = await client.query<Row>(`${lineage}, candidates AS (
    SELECT r.*,o.kind,c.depth FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id
    JOIN lore_objects o ON o.id=r.object_id AND o.world_id=r.world_id
    WHERE r.revision<=c.cutoff AND r.effective_day<=c.day AND o.kind IN ('maps','map_layers','map_features','events')
  ) SELECT DISTINCT ON(object_id) * FROM candidates ORDER BY object_id,depth,effective_day DESC,revision DESC`, [timeline.id, cutoff, day]);
  return found.rows;
}

function value<T>(row: Row): T {
  return { ...row.data, id: row.object_id, worldId: row.world_id, version: row.version } as T;
}

async function mapScope(client: PoolClient, userId: string, mapId: string, options: TemporalOptions, write = false) {
  const identity = await client.query<{ world_id: string }>("SELECT world_id FROM lore_objects WHERE id=$1 AND kind='maps'", [mapId]);
  if (!identity.rows[0]) throw new ApiError(404, "Карта не найдена");
  const scoped = await context(client, userId, identity.rows[0].world_id, options, write);
  const rows = await resolve(client, scoped.timeline, options.day, options.revision);
  const map = rows.find((row) => row.object_id === mapId && !row.deleted);
  if (!map) throw new ApiError(404, "Карта не найдена в этой линии на выбранную дату");
  return { scoped, rows, map };
}

function mapData(rows: Row[], mapId: string, revision: string): MapData {
  const map = rows.find((row) => row.object_id === mapId && row.kind === "maps" && !row.deleted);
  if (!map) throw new ApiError(404, "Карта не найдена в этой линии на выбранную дату");
  return {
    map: value<AtlasMap>(map), revision,
    layers: rows.filter((row) => !row.deleted && row.kind === "map_layers" && row.data?.mapId === mapId).map((row) => value<MapLayer>(row)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id)),
    features: rows.filter((row) => !row.deleted && row.kind === "map_features" && row.data?.mapId === mapId).map((row) => value<MapFeature>(row)).sort((a, b) => a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id)),
  };
}

function writableDay(timeline: Timeline, explicit?: string, existingDay = BASELINE_DAY): string {
  const day = explicit ?? (timeline.forkDay !== null && BigInt(existingDay) < BigInt(timeline.forkDay) ? timeline.forkDay : existingDay);
  if (timeline.forkDay !== null && BigInt(day) < BigInt(timeline.forkDay)) throw new ApiError(400, "Правки дочерней линии не могут предшествовать дате ответвления");
  return day;
}

function latestMapDay(rows: Row[], mapId: string) {
  return rows.filter((row) => row.object_id === mapId || row.data?.mapId === mapId).reduce((latest, row) => BigInt(row.effective_day) > BigInt(latest) ? row.effective_day : latest, BASELINE_DAY);
}

async function append(client: PoolClient, scoped: Scope, userId: string, id: string, kind: MapKind, day: string, data: Fact | null, before?: Row) {
  const counter = await client.query<{ version: number }>("UPDATE lore_objects SET version=version+1 WHERE id=$1 AND world_id=$2 AND kind=$3 RETURNING version", [id, scoped.world.id, kind]);
  if (!counter.rows[0]) throw new ApiError(404, "Географический объект не найден");
  const geometry = kind === "map_features" && data ? JSON.stringify(data.geometry) : null;
  const inserted = await client.query<Row>(`INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,deleted,data,actor_id,geometry)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,CASE WHEN $9::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($9::jsonb),0) END) RETURNING *`,
  [id, scoped.world.id, scoped.timeline.id, day, counter.rows[0].version, data === null, data === null ? null : JSON.stringify(data), userId, geometry]);
  const row = { ...inserted.rows[0], kind };
  await client.query("UPDATE timelines SET head_revision=$1 WHERE id=$2", [row.revision, scoped.timeline.id]);
  scoped.timeline.headRevision = row.revision;
  await audit(client, scoped.world.projectId, userId, kind, id, data === null ? "delete" : before && !before.deleted ? "update" : "create", {
    timelineId: scoped.timeline.id, effectiveDay: day, revision: row.revision,
    ...(before && !before.deleted ? { before: value(before) } : {}), ...(data ? { after: value(row) } : {}),
  });
  return row;
}

async function newIdentity(client: PoolClient, worldId: string, kind: MapKind, id: string = randomUUID()) {
  // Client UUIDs identify new draft objects; they may never claim an old identity.
  if ((await client.query("SELECT 1 FROM lore_objects WHERE id=$1", [id])).rowCount) throw new ApiError(409, "Идентификатор нового объекта уже занят. Перечитайте карту");
  await client.query("INSERT INTO lore_objects(id,world_id,kind) VALUES($1,$2,$3)", [id, worldId, kind]);
  return id;
}

async function spatial(client: PoolClient, geometry: MapGeometry, map: AtlasMap): Promise<void> {
  geometrySchema.parse(geometry);
  const checked = await client.query<{ valid: boolean; simple: boolean; empty: boolean; inside: boolean; reason: string; points: number }>(`WITH input AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),0) AS g)
    SELECT ST_IsValid(g) AS valid,ST_IsSimple(g) AS simple,ST_IsEmpty(g) AS empty,ST_IsValidReason(g) AS reason,ST_NPoints(g) AS points,
      CASE WHEN ST_IsValid(g) THEN ST_CoveredBy(g,ST_MakeEnvelope(0,0,$2,$3,0)) ELSE false END AS inside FROM input`, [JSON.stringify(geometry), map.width, map.height]);
  const check = checked.rows[0];
  if (!check.valid || check.empty) throw new ApiError(400, `Некорректная геометрия: ${check.reason}`);
  if (!check.simple) throw new ApiError(400, "Геометрия не должна пересекать саму себя");
  if (!check.inside) throw new ApiError(400, "Геометрия выходит за пределы карты");
  if (check.points > 10000) throw new ApiError(400, "В одном объекте может быть не больше 10000 вершин");
}

async function breakpoints(client: PoolClient, timeline: Timeline, from: string): Promise<string[]> {
  const found = await client.query<{ effective_day: string }>(`${lineage} SELECT DISTINCT r.effective_day FROM lineage c
    JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id AND r.revision<=c.cutoff AND r.effective_day<=c.day
    JOIN lore_objects o ON o.id=r.object_id AND o.world_id=r.world_id
    WHERE o.kind IN ('maps','map_layers','map_features') AND r.effective_day>=$4`, [timeline.id, timeline.headRevision, LATEST_DAY, from]);
  return [...new Set([from, ...found.rows.map((row) => row.effective_day)])].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
}

function assertMapReferences(rows: Row[], mapId: string) {
  const live = rows.filter((row) => !row.deleted);
  const map = live.find((row) => row.object_id === mapId && row.kind === "maps");
  const layers = live.filter((row) => row.kind === "map_layers" && row.data?.mapId === mapId);
  const features = live.filter((row) => row.kind === "map_features" && row.data?.mapId === mapId);
  if (!map && (layers.length || features.length)) throw new ApiError(400, "Правка оставляет географические объекты без карты в историческом состоянии");
  if (layers.length > 100 || features.length > 5000) throw new ApiError(400, "На карте может быть не больше 100 слоёв и 5000 объектов");
  const layerIds = new Set(layers.map((row) => row.object_id));
  const featureIds = new Map(features.map((row) => [row.object_id, row]));
  for (const row of features) {
    if (!layerIds.has(String(row.data!.layerId))) throw new ApiError(400, "Сначала удалите или перенесите объекты слоя: правка оставляет ссылку на отсутствующий слой");
    const parentId = row.data!.parentId as string | null;
    if (parentId !== null) {
      const parent = featureIds.get(parentId);
      if (!parent || !["state", "province"].includes(String(parent.data!.kind))) throw new ApiError(400, "Родитель должен быть государством или провинцией той же карты");
      const seen = new Set([row.object_id]);
      let current: Row | undefined = parent;
      while (current) {
        if (seen.has(current.object_id)) throw new ApiError(400, "Географические объекты не могут образовывать цикл подчинения");
        seen.add(current.object_id);
        const next = current.data!.parentId as string | null;
        current = next === null ? undefined : featureIds.get(next);
      }
    }
  }
}

async function consistent(client: PoolClient, scoped: Scope, mapId: string, day: string) {
  for (const point of await breakpoints(client, scoped.timeline, day)) assertMapReferences(await resolve(client, scoped.timeline, point), mapId);
}

async function eventLink(client: PoolClient, scoped: Scope, day: string, feature: MapFeatureInput, previous?: Row) {
  // An unchanged archived reference is meaningful history. Only assignment of a
  // new event requires that event to be visible in this exact source context.
  if (feature.eventId === null || feature.eventId === previous?.data?.eventId) return;
  const events = await resolve(client, scoped.timeline, day);
  if (!events.some((row) => row.object_id === feature.eventId && row.kind === "events" && !row.deleted)) throw new ApiError(400, "Связанное событие должно существовать в этом мире, линии и на выбранную дату");
}

export async function listMaps(client: PoolClient, userId: string, worldId: string, options: TemporalOptions = {}) {
  const scoped = await context(client, userId, worldId, options);
  const rows = await resolve(client, scoped.timeline, options.day, options.revision);
  return { maps: rows.filter((row) => row.kind === "maps" && !row.deleted).map((row) => value<AtlasMap>(row)).sort((a, b) => a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id)), revision: options.revision ?? scoped.timeline.headRevision };
}

export async function getMap(client: PoolClient, userId: string, mapId: string, options: TemporalOptions = {}): Promise<MapData> {
  const { scoped, rows } = await mapScope(client, userId, mapId, options);
  return mapData(rows, mapId, options.revision ?? scoped.timeline.headRevision);
}

export async function createMap(client: PoolClient, userId: string, worldId: string, input: MapInput, options: TemporalOptions = {}): Promise<MapData> {
  const data = mapCreateSchema.parse(input);
  const scoped = await context(client, userId, worldId, options, true);
  const day = writableDay(scoped.timeline, options.day);
  const id = await newIdentity(client, worldId, "maps");
  await append(client, scoped, userId, id, "maps", day, data);
  const layers: MapLayerInput[] = [
    { name: "Физическая основа", kind: "physical", visible: true, locked: false, opacity: 1, order: 0 },
    { name: "Политические границы", kind: "political", visible: true, locked: false, opacity: 1, order: 1 },
  ];
  for (const layer of layers) {
    const layerId = await newIdentity(client, worldId, "map_layers");
    await append(client, scoped, userId, layerId, "map_layers", day, { ...layer, mapId: id });
  }
  return mapData(await resolve(client, scoped.timeline, options.day), id, scoped.timeline.headRevision);
}

export async function updateMap(client: PoolClient, userId: string, mapId: string, input: MapPatch, options: TemporalOptions = {}): Promise<MapData> {
  const changes = mapPatchSchema.parse(input);
  const { scoped, map } = await mapScope(client, userId, mapId, options, true);
  if (changes.version !== map.version) throw new ApiError(409, "Карта изменена в другом окне. Перечитайте данные перед сохранением");
  const { version, ...patch } = changes; void version;
  const next = mapCreateSchema.parse({ ...map.data, ...patch });
  const day = writableDay(scoped.timeline, options.day, map.effective_day);
  await append(client, scoped, userId, mapId, "maps", day, next, map);
  return mapData(await resolve(client, scoped.timeline, options.day), mapId, scoped.timeline.headRevision);
}

export async function deleteMap(client: PoolClient, userId: string, mapId: string, version: number, options: TemporalOptions = {}) {
  const { scoped, map } = await mapScope(client, userId, mapId, options, true);
  if (version !== map.version) throw new ApiError(409, "Карта изменена в другом окне. Перечитайте данные перед удалением");
  const day = writableDay(scoped.timeline, options.day, map.effective_day);
  const points = await breakpoints(client, scoped.timeline, day);
  for (const point of points) {
    const rows = await resolve(client, scoped.timeline, point);
    for (const row of rows.filter((item) => !item.deleted && (item.object_id === mapId || item.data?.mapId === mapId))) {
      await append(client, scoped, userId, row.object_id, row.kind as MapKind, point, null, row);
    }
  }
  await consistent(client, scoped, mapId, day);
  return { ok: true };
}

export async function saveMapContent(client: PoolClient, userId: string, mapId: string, input: MapBatchInput, options: TemporalOptions = {}): Promise<MapData> {
  const changes = mapBatchSchema.parse(input);
  const { scoped, rows, map } = await mapScope(client, userId, mapId, options, true);
  if (changes.expectedRevision !== scoped.timeline.headRevision) throw new ApiError(409, "Временная линия изменилась. Перечитайте карту перед сохранением");
  const day = writableDay(scoped.timeline, options.day, latestMapDay(rows, mapId));
  const atDay = await resolve(client, scoped.timeline, day);
  const current = new Map(atDay.filter((row) => !row.deleted && row.data?.mapId === mapId).map((row) => [row.object_id, row]));
  const plans = [
    ...changes.layers.map((change) => ({ kind: "map_layers" as const, change })),
    ...changes.features.map((change) => ({ kind: "map_features" as const, change })),
  ];
  const removed = new Set<string>();
  const mapValue = value<AtlasMap>(map);
  for (const { kind, change } of plans) {
    const previous = current.get(change.id);
    if (change.op !== "create") {
      if (!previous || previous.kind !== kind) throw new ApiError(404, "Изменяемый объект не найден в этой карте, линии и на выбранную дату");
      if (change.version !== previous.version) throw new ApiError(409, "Объект карты изменён в другом окне. Перечитайте данные");
    }
    if (change.op !== "delete" && kind === "map_features") {
      const feature = change.data as MapFeatureInput;
      await spatial(client, feature.geometry, mapValue);
      await eventLink(client, scoped, day, feature, previous);
    }
    if (change.op === "create") await newIdentity(client, scoped.world.id, kind, change.id);
    const data = change.op === "delete" ? null : { ...change.data, mapId };
    await append(client, scoped, userId, change.id, kind, day, data, previous);
    if (change.op === "delete") removed.add(change.id);
  }
  // A deletion cancels previously scheduled resurrections of that exact object.
  // Referencing future children must still be deleted/reparented by the caller.
  if (removed.size) for (const point of await breakpoints(client, scoped.timeline, day)) {
    if (point === day) continue;
    for (const row of await resolve(client, scoped.timeline, point)) {
      if (!row.deleted && removed.has(row.object_id)) await append(client, scoped, userId, row.object_id, row.kind as MapKind, point, null, row);
    }
  }
  await consistent(client, scoped, mapId, day);
  return mapData(await resolve(client, scoped.timeline, options.day), mapId, scoped.timeline.headRevision);
}

export async function mergeMapGeometry(client: PoolClient, userId: string, mapId: string, input: { geometries: PolygonGeometry[] }, options: TemporalOptions = {}) {
  const data = mapMergeSchema.parse(input);
  const { map } = await mapScope(client, userId, mapId, options, true);
  const mapValue = value<AtlasMap>(map);
  for (const geometry of data.geometries) await spatial(client, geometry, mapValue);
  if (data.geometries.reduce((count, geometry) => count + countGeometryVertices(geometry), 0) > 100000) throw new ApiError(400, "Слишком много вершин для объединения");
  const found = await client.query<{ geometry: MapGeometry }>(`WITH input AS (
    SELECT ST_SetSRID(ST_GeomFromGeoJSON(value),0) AS g FROM jsonb_array_elements($1::jsonb)
  ) SELECT ST_AsGeoJSON(ST_UnaryUnion(ST_Collect(g)),15,0)::jsonb AS geometry FROM input`, [JSON.stringify(data.geometries)]);
  const geometry = geometrySchema.parse(found.rows[0].geometry);
  await spatial(client, geometry, mapValue);
  return { geometry };
}

export async function splitMapGeometry(client: PoolClient, userId: string, mapId: string, input: { geometry: PolygonGeometry; cutter: Extract<MapGeometry, { type: "LineString" }> }, options: TemporalOptions = {}) {
  const data = mapSplitSchema.parse(input);
  const { map } = await mapScope(client, userId, mapId, options, true);
  const mapValue = value<AtlasMap>(map);
  await spatial(client, data.geometry, mapValue);
  await spatial(client, data.cutter, mapValue);
  const result = await client.query<{ geometry: MapGeometry }>(`WITH parts AS (
    SELECT ST_Dump(ST_CollectionExtract(ST_Split(ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),0),ST_SetSRID(ST_GeomFromGeoJSON($2::jsonb),0)),3)) AS part
  ) SELECT ST_AsGeoJSON((part).geom,15,0)::jsonb AS geometry FROM parts ORDER BY ST_XMin(Box3D((part).geom)),ST_YMin(Box3D((part).geom))`, [JSON.stringify(data.geometry), JSON.stringify(data.cutter)]);
  if (result.rows.length < 2 || result.rows.length > 20) throw new ApiError(400, "Линия должна разделять территорию на 2–20 частей");
  const geometries = result.rows.map((row) => geometrySchema.parse(row.geometry));
  for (const geometry of geometries) await spatial(client, geometry, mapValue);
  return { geometries };
}

export async function mapFeatureHistory(client: PoolClient, userId: string, id: string, options: TemporalOptions = {}): Promise<MapFeatureHistory> {
  const identity = await client.query<{ world_id: string }>("SELECT world_id FROM lore_objects WHERE id=$1 AND kind='map_features'", [id]);
  if (!identity.rows[0]) throw new ApiError(404, "Географический объект не найден");
  const scoped = await context(client, userId, identity.rows[0].world_id, options);
  const found = await client.query<Row>(`${lineage} SELECT r.* FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id
    WHERE r.object_id=$4 AND r.revision<=c.cutoff AND r.effective_day<=c.day ORDER BY r.revision DESC`, [scoped.timeline.id, options.revision ?? scoped.timeline.headRevision, options.day ?? LATEST_DAY, id]);
  if (!found.rows.length) throw new ApiError(404, "История объекта недоступна в этой линии на выбранную дату");
  const revisions: Revision[] = found.rows.map((row) => ({
    revision: row.revision, timelineId: row.timeline_id, effectiveDay: row.effective_day, version: row.version,
    deleted: row.deleted, data: row.data, createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }));
  return { revisions };
}
