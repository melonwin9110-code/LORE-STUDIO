import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { Character, LoreEvent, Project, User, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { AtlasMap, MapBatchInput, MapData, MapFeature, MapFeatureHistory, MapFeatureInput, MapGeometry, MapLayerInput } from "../../src/lib/map-types";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
const origin = new URL(base).origin;
const databaseURL = process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(new URL(databaseURL).pathname.slice(1)))) throw new Error("Map checks require a dedicated *_test database");
const database = new pg.Pool({ connectionString: databaseURL });
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
class Client {
  cookie = "";
  async call<T = { error?: string }>(method: string, path: string, input?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { Origin: origin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    return { status: response.status, data: await response.json() as T };
  }
}
const scope = (timeline: string, day?: string, revision?: string) => `?${new URLSearchParams({ timeline, ...(day === undefined ? {} : { day }), ...(revision === undefined ? {} : { revision }) })}`;
const rectangle = (x = 100, y = 100, width = 200, height = 200): MapGeometry => ({ type: "Polygon", coordinates: [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]] });
const featureData = (layerId: string, extra: Partial<MapFeatureInput> = {}): MapFeatureInput => ({ name: "Северное государство", kind: "state", layerId, geometry: rectangle(), description: "Проверка сохранения границ", fill: "#8564b3", stroke: "#ceb7ee", strokeWidth: 1.5, label: true, eventId: null, parentId: null, ...extra });
const featureInput = (feature: MapFeature, extra: Partial<MapFeatureInput> = {}): MapFeatureInput => ({ name: feature.name, kind: feature.kind, layerId: feature.layerId, geometry: feature.geometry, description: feature.description, fill: feature.fill, stroke: feature.stroke, strokeWidth: feature.strokeWidth, label: feature.label, eventId: feature.eventId, parentId: feature.parentId, ...extra });

describe("maps 0.4: spatial storage, temporal boundaries and editor transactions", () => {
  const owner = new Client(), stranger = new Client(), reader = new Client(), anonymous = new Client();
  let project: Project, otherProject: Project, readerId: string;
  let world: World, main: Timeline, map: MapData, foreignMap: MapData;
  const political = (value = map) => value.layers.find((layer) => layer.kind === "political")!;
  const physical = (value = map) => value.layers.find((layer) => layer.kind === "physical")!;
  async function newWorld(name: string, client = owner, projectId = project.id) {
    const created = await client.call<{ world: World }>("POST", `/projects/${projectId}/worlds`, { name });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const loaded = await client.call<WorldData>("GET", `/worlds/${created.data.world.id}`);
    expect(loaded.status, JSON.stringify(loaded.data)).toBe(200);
    return { world: created.data.world, main: loaded.data.history!.timeline };
  }
  async function createMap(name = "Атлас проверяемого мира", worldId = world.id, timeline = main.id, client = owner, day = "10") {
    const created = await client.call<MapData>("POST", `/worlds/${worldId}/maps${scope(timeline, day)}`, { name, description: "Собственная география", width: 1000, height: 700, background: "#142936" });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    return created.data;
  }
  async function state(timeline = main.id, day?: string, mapId = map.map.id) {
    const loaded = await owner.call<MapData>("GET", `/maps/${mapId}${scope(timeline, day)}`);
    expect(loaded.status, JSON.stringify(loaded.data)).toBe(200);
    return loaded.data;
  }
  async function save(input: Pick<MapBatchInput, "features"> & Partial<Pick<MapBatchInput, "layers" | "expectedRevision">>, timeline = main.id, day = "10", mapId = map.map.id) {
    const latest = await state(timeline, day, mapId);
    return owner.call<MapData>("PUT", `/maps/${mapId}/content${scope(timeline, day)}`, { expectedRevision: latest.revision, layers: [], ...input });
  }
  async function addFeature(extra: Partial<MapFeatureInput> = {}, timeline = main.id, day = "10") {
    const id = randomUUID();
    const result = await save({ features: [{ op: "create", id, data: featureData(political().id, extra) }] }, timeline, day);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data.features.find((value) => value.id === id)!;
  }
  async function fork(parentId = main.id, day = "15") {
    const current = await owner.call<WorldData>("GET", `/worlds/${world.id}${scope(parentId)}`);
    expect(current.status).toBe(200);
    const created = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: `Географическая ветвь ${randomUUID().slice(0, 6)}`, parentId, forkDay: day, expectedParentRevision: current.data.history!.timeline.headRevision });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    return created.data.timeline;
  }
  async function event(name: string, day = "10", worldId = world.id, timeline = main.id, client = owner) {
    const created = await client.call<{ event: LoreEvent }>("POST", `/worlds/${worldId}/events${scope(timeline, day)}`, { name, startYear: 1000, description: "Причина изменения границ" });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    return created.data.event;
  }
  beforeAll(async () => {
    for (const [client, name] of [[owner, "owner"], [stranger, "stranger"], [reader, "reader"]] as const) {
      const result = await client.call<{ user: User }>("POST", "/auth/register", { name, email: `maps-${name}-${suffix}@example.test`, password: "Map-editor-test-password-2026!" });
      expect(result.status, JSON.stringify(result.data)).toBe(201);
      if (client === reader) readerId = result.data.user.id;
    }
    const own = await owner.call<{ project: Project }>("POST", "/projects", { name: `Атлас проекта ${suffix}` });
    expect(own.status).toBe(201); project = own.data.project;
    const other = await stranger.call<{ project: Project }>("POST", "/projects", { name: `Закрытая география ${suffix}` });
    expect(other.status).toBe(201); otherProject = other.data.project;
    const foreign = await newWorld("Чужая география", stranger, otherProject.id);
    foreignMap = await createMap("Секретный атлас", foreign.world.id, foreign.main.id, stranger);
  }, 60000);
  beforeEach(async () => {
    const fresh = await newWorld("Мир географической проверки"); world = fresh.world; main = fresh.main;
    map = await createMap();
  });
  afterAll(async () => {
    if (project) await owner.call("DELETE", `/projects/${project.id}`);
    if (otherProject) await stranger.call("DELETE", `/projects/${otherProject.id}`);
    await owner.call("POST", "/auth/logout"); await stranger.call("POST", "/auth/logout"); await reader.call("POST", "/auth/logout");
    await database.end();
  });

  it("creates an empty local atlas and two persisted layers without exposing a map before its creation day", async () => {
    expect(map.map).toMatchObject({ name: "Атлас проверяемого мира", worldId: world.id, width: 1000, height: 700, background: "#142936", version: 1 });
    expect(map.features).toEqual([]); expect(map.layers).toHaveLength(2);
    expect(new Set(map.layers.map((layer) => layer.kind))).toEqual(new Set(["physical", "political"]));
    const before = await owner.call<{ maps: AtlasMap[] }>("GET", `/worlds/${world.id}/maps${scope(main.id, "9")}`);
    expect(before.status).toBe(200); expect(before.data.maps).toEqual([]);
    const after = await owner.call<{ maps: AtlasMap[] }>("GET", `/worlds/${world.id}/maps${scope(main.id, "10")}`);
    expect(after.data.maps.map((value) => value.id)).toEqual([map.map.id]);
    expect(await state()).toEqual(map);
  });

  it("stores semantic polygons, lines and cities as real valid PostGIS geometries", async () => {
    const cityId = randomUUID(), riverId = randomUUID(), stateId = randomUUID();
    const city = featureData(physical().id, { kind: "city", name: "Светлая гавань", geometry: { type: "Point", coordinates: [240, 180] }, fill: "#e4c384" });
    const river = featureData(physical().id, { kind: "river", name: "Серебряная река", geometry: { type: "LineString", coordinates: [[40, 60], [160, 180], [340, 260]] } });
    const result = await save({ features: [{ op: "create", id: cityId, data: city }, { op: "create", id: riverId, data: river }, { op: "create", id: stateId, data: featureData(political().id) }] });
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const reread = await state(); expect(reread.features).toHaveLength(3);
    expect(reread.features.find((value) => value.id === cityId)).toMatchObject({ ...city, id: cityId, version: 1 });
    const spatial = await database.query<{ object_id: string; valid: boolean; srid: number; kind: string; same: boolean }>(`SELECT DISTINCT ON(object_id) object_id,ST_IsValid(geometry) AS valid,ST_SRID(geometry) AS srid,GeometryType(geometry) AS kind,ST_Equals(geometry,ST_SetSRID(ST_GeomFromGeoJSON(data->'geometry'),0)) AS same FROM lore_revisions WHERE object_id=ANY($1::uuid[]) ORDER BY object_id,revision DESC`, [[cityId, riverId, stateId]]);
    expect(spatial.rows).toHaveLength(3);
    for (const row of spatial.rows) expect(row).toMatchObject({ valid: true, srid: 0, same: true });
    expect(new Set(spatial.rows.map((row) => row.kind))).toEqual(new Set(["POINT", "LINESTRING", "POLYGON"]));
  });

  it("enforces spatial payload agreement and immutable geometry in PostgreSQL itself", async () => {
    const feature = await addFeature();
    const before = await database.query("SELECT revision::text,data,ST_AsEWKT(geometry) AS geometry FROM lore_revisions WHERE object_id=$1 ORDER BY revision", [feature.id]);
    const columns = "object_id,world_id,timeline_id,effective_day,version,deleted,data,actor_id,geometry";
    for (const expression of ["NULL", "ST_SetSRID(ST_GeomFromText('POLYGON((500 100,700 100,700 300,500 300,500 100))'),0)"]) {
      await expect(database.query(`INSERT INTO lore_revisions(${columns}) SELECT object_id,world_id,timeline_id,effective_day,version+1,false,data,actor_id,${expression} FROM lore_revisions WHERE object_id=$1 ORDER BY revision DESC LIMIT 1`, [feature.id])).rejects.toMatchObject({ code: "23514" });
    }
    await expect(database.query("UPDATE lore_revisions SET geometry=ST_Translate(geometry,1,1) WHERE object_id=$1", [feature.id])).rejects.toThrow(/immutable/i);
    await expect(database.query("DELETE FROM lore_revisions WHERE object_id=$1", [feature.id])).rejects.toThrow(/immutable/i);
    const after = await database.query("SELECT revision::text,data,ST_AsEWKT(geometry) AS geometry FROM lore_revisions WHERE object_id=$1 ORDER BY revision", [feature.id]);
    expect(after.rows).toEqual(before.rows);
  });

  it("rejects self-intersections, unclosed rings, out-of-bounds coordinates and semantic shape mismatches without partial writes", async () => {
    const invalids: MapFeatureInput[] = [
      featureData(political().id, { geometry: { type: "Polygon", coordinates: [[[100, 100], [300, 300], [100, 300], [300, 100], [100, 100]]] } }),
      featureData(political().id, { geometry: { type: "Polygon", coordinates: [[[100, 100], [300, 100], [300, 300], [100, 300]]] } }),
      featureData(political().id, { geometry: rectangle(950, 100) }),
      featureData(political().id, { geometry: rectangle(-1, 100) }),
      featureData(political().id, { kind: "river", geometry: rectangle() }),
      featureData(physical().id, { kind: "city", geometry: { type: "Point", coordinates: [500, 701] } }),
    ];
    const before = await state();
    for (const data of invalids) {
      const result = await save({ features: [{ op: "create", id: randomUUID(), data: featureData(political().id, { name: "Не должна сохраниться" }) }, { op: "create", id: randomUUID(), data }] });
      expect(result.status, JSON.stringify(result.data)).toBe(400);
      expect(await state()).toEqual(before);
    }
  });

  it("edits layer properties and feature style together, then atomically deletes an emptied custom layer", async () => {
    const layerId = randomUUID(), featureId = randomUUID();
    const layer: MapLayerInput = { name: "Торговые пути", kind: "custom", visible: true, locked: false, opacity: 0.75, order: 4 };
    const created = await save({ layers: [{ op: "create", id: layerId, data: layer }], features: [{ op: "create", id: featureId, data: featureData(layerId, { kind: "road", name: "Дорога рассвета", geometry: { type: "LineString", coordinates: [[50, 50], [500, 500]] } }) }] });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const oldLayer = created.data.layers.find((value) => value.id === layerId)!, oldFeature = created.data.features[0];
    const updated = await save({ layers: [{ op: "update", id: layerId, version: oldLayer.version, data: { ...layer, name: "Зимние пути", visible: false, opacity: 0.5 } }], features: [{ op: "update", id: featureId, version: oldFeature.version, data: featureInput(oldFeature, { stroke: "#ffffff", strokeWidth: 4, label: false }) }] });
    expect(updated.status, JSON.stringify(updated.data)).toBe(200);
    expect(updated.data.layers.find((value) => value.id === layerId)).toMatchObject({ name: "Зимние пути", visible: false, opacity: 0.5, version: 2 });
    expect(updated.data.features[0]).toMatchObject({ stroke: "#ffffff", strokeWidth: 4, label: false, version: 2 });
    expect((await save({ layers: [{ op: "delete", id: layerId, version: 2 }], features: [] })).status).toBe(400);
    const removed = await save({ layers: [{ op: "delete", id: layerId, version: 2 }], features: [{ op: "delete", id: featureId, version: 2 }] });
    expect(removed.status, JSON.stringify(removed.data)).toBe(200);
    expect(removed.data.layers.some((value) => value.id === layerId)).toBe(false); expect(removed.data.features).toEqual([]);
  });

  it("rejects stale object versions and stale line heads while leaving the winning save intact", async () => {
    const feature = await addFeature();
    const snapshot = await state();
    const changed = await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Сохранённая победившая правка" }) }] });
    expect(changed.status).toBe(200);
    const staleHead = await owner.call("PUT", `/maps/${map.map.id}/content${scope(main.id, "10")}`, { expectedRevision: snapshot.revision, layers: [], features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Потерянная правка" }) }] });
    expect(staleHead.status).toBe(409);
    const staleVersion = await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Устаревшая версия объекта" }) }] });
    expect(staleVersion.status).toBe(409);
    expect((await state()).features[0].name).toBe("Сохранённая победившая правка");
    const duplicate = await save({ features: [{ op: "create", id: feature.id, data: featureInput(feature) }] });
    expect(duplicate.status).toBe(409);
  });

  it("resolves historical geometry and properties by effective day and keeps previous facts immutable", async () => {
    const feature = await addFeature();
    const before = await database.query("SELECT revision::text,data,ST_AsEWKT(geometry) AS geometry FROM lore_revisions WHERE object_id=$1 ORDER BY revision", [feature.id]);
    const hash = createHash("sha256").update(JSON.stringify(before.rows)).digest("hex");
    const late = await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Новые границы", geometry: rectangle(200, 150, 300, 250), fill: "#bb785e" }) }] }, main.id, "30");
    expect(late.status, JSON.stringify(late.data)).toBe(200);
    expect((await state(main.id, "20")).features[0]).toMatchObject({ name: feature.name, geometry: feature.geometry, fill: feature.fill });
    expect((await state(main.id, "30")).features[0]).toMatchObject({ name: "Новые границы", geometry: rectangle(200, 150, 300, 250), fill: "#bb785e" });
    const oldFacts = await database.query("SELECT revision::text,data,ST_AsEWKT(geometry) AS geometry FROM lore_revisions WHERE object_id=$1 AND revision<=$2 ORDER BY revision", [feature.id, before.rows.at(-1)!.revision]);
    expect(createHash("sha256").update(JSON.stringify(oldFacts.rows)).digest("hex")).toBe(hash);
    const history = await owner.call<MapFeatureHistory>("GET", `/map-features/${feature.id}/history${scope(main.id)}`);
    expect(history.status, JSON.stringify(history.data)).toBe(200);
    expect(history.data.revisions.map((value) => value.effectiveDay).sort()).toEqual(["10", "30"]);
    expect(history.data.revisions.some((value) => value.data?.name === feature.name)).toBe(true);
  });

  it("pins a branch to both the parent revision and fork day, including future and backdated parent edits", async () => {
    const feature = await addFeature();
    const future = await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Будущая география", geometry: rectangle(500, 200) }) }] }, main.id, "40");
    expect(future.status).toBe(200);
    const branch = await fork(main.id, "15");
    expect((await state(branch.id)).features[0]).toMatchObject({ name: feature.name, geometry: feature.geometry });
    const at10 = (await state(main.id, "10")).features[0];
    expect((await save({ features: [{ op: "update", id: feature.id, version: at10.version, data: featureInput(at10, { name: "Поздняя правка задним числом", geometry: rectangle(20, 20) }) }] }, main.id, "10")).status).toBe(200);
    expect((await state(branch.id)).features[0]).toMatchObject({ name: feature.name, geometry: feature.geometry });
    const branchChanged = await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Политика альтернативной линии", geometry: rectangle(400, 100) }) }] }, branch.id, "20");
    expect(branchChanged.status, JSON.stringify(branchChanged.data)).toBe(200);
    expect((await state(main.id, "20")).features[0].name).toBe("Поздняя правка задним числом");
    expect((await state(branch.id, "20")).features[0].name).toBe("Политика альтернативной линии");
    expect((await save({ features: [{ op: "create", id: randomUUID(), data: featureData(political().id) }] }, branch.id, "14")).status).toBe(400);
  });

  it("inherits map identities down nested pinned branches and leaves an independent timeline empty", async () => {
    const feature = await addFeature();
    const first = await fork(main.id, "15"), second = await fork(first.id, "20"), third = await fork(second.id, "25");
    for (const branch of [first, second, third]) expect((await state(branch.id)).features[0].id).toBe(feature.id);
    const changed = await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { name: "Глубокая независимая правка" }) }] }, third.id, "30");
    expect(changed.status).toBe(200);
    expect((await state(first.id)).features[0].name).toBe(feature.name);
    const independent = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: "Отдельная география" });
    expect(independent.status).toBe(201);
    const listed = await owner.call<{ maps: AtlasMap[] }>("GET", `/worlds/${world.id}/maps${scope(independent.data.timeline.id)}`);
    expect(listed.status).toBe(200); expect(listed.data.maps).toEqual([]);
    expect((await owner.call("GET", `/maps/${map.map.id}${scope(independent.data.timeline.id)}`)).status).toBe(404);
  });

  it("preserves old map states and pinned descendants after a temporal map deletion, including future features", async () => {
    const baseline = await addFeature();
    const future = await addFeature({ name: "Город будущего", kind: "city", layerId: physical().id, geometry: { type: "Point", coordinates: [600, 300] } }, main.id, "40");
    const branch = await fork(main.id, "25");
    const removed = await owner.call("DELETE", `/maps/${map.map.id}${scope(main.id, "20")}`, { version: map.map.version });
    expect(removed.status, JSON.stringify(removed.data)).toBe(200);
    expect((await state(main.id, "15")).features.map((value) => value.id)).toEqual([baseline.id]);
    for (const day of ["20", "40", "50"]) {
      expect((await owner.call("GET", `/maps/${map.map.id}${scope(main.id, day)}`)).status).toBe(404);
      expect((await owner.call<{ maps: AtlasMap[] }>("GET", `/worlds/${world.id}/maps${scope(main.id, day)}`)).data.maps).toEqual([]);
    }
    expect((await state(branch.id)).features.map((value) => value.id)).toEqual([baseline.id]);
    const tombstones = await database.query("SELECT object_id FROM lore_revisions WHERE object_id=$1 AND deleted", [future.id]);
    expect(tombstones.rows.length).toBeGreaterThan(0);
  });

  it("protects references at later dates when removing a layer in the past", async () => {
    await addFeature({ name: "Будущая провинция" }, main.id, "30");
    const before = await state(main.id, "30");
    const result = await save({ layers: [{ op: "delete", id: political().id, version: political().version }], features: [] }, main.id, "20");
    expect(result.status, JSON.stringify(result.data)).toBe(400);
    expect(await state(main.id, "30")).toEqual(before);
  });

  it("checks territorial parent references and cycles against the final atomic batch", async () => {
    const parentId = randomUUID(), childId = randomUUID();
    const created = await save({ features: [
      { op: "create", id: childId, data: featureData(political().id, { name: "Пограничная провинция", kind: "province", parentId, geometry: rectangle(120, 120, 50, 50) }) },
      { op: "create", id: parentId, data: featureData(political().id, { name: "Государство-родитель" }) },
    ] });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const parent = created.data.features.find((value) => value.id === parentId)!, child = created.data.features.find((value) => value.id === childId)!;
    const cycle = await save({ features: [{ op: "update", id: parentId, version: parent.version, data: featureInput(parent, { parentId: childId }) }] });
    expect(cycle.status).toBe(400);
    const orphan = await save({ features: [{ op: "delete", id: parentId, version: parent.version }] });
    expect(orphan.status).toBe(400);
    expect((await state()).features).toEqual(created.data.features);
    const removed = await save({ features: [{ op: "delete", id: parentId, version: parent.version }, { op: "delete", id: childId, version: child.version }] });
    expect(removed.status).toBe(200); expect(removed.data.features).toEqual([]);
  });

  it("links a geographic change to a visible event and rejects foreign or future event references", async () => {
    const localEvent = await event("Раздел империи");
    const feature = await addFeature({ eventId: localEvent.id });
    expect(feature.eventId).toBe(localEvent.id);
    const other = await newWorld("Другой доступный мир");
    const otherEvent = await event("Событие другого мира", "10", other.world.id, other.main.id);
    const future = await event("Будущий договор", "30");
    for (const eventId of [otherEvent.id, future.id, randomUUID()]) {
      expect((await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { eventId }) }] })).status).toBe(400);
    }
    const deleted = await owner.call("DELETE", `/events/${localEvent.id}${scope(main.id, "20")}`);
    expect(deleted.status).toBe(200);
    expect((await state(main.id, "20")).features[0].eventId).toBe(localEvent.id);
    const history = await owner.call<MapFeatureHistory>("GET", `/map-features/${feature.id}/history${scope(main.id)}`);
    expect(history.data.revisions.some((value) => value.data?.eventId === localEvent.id)).toBe(true);
  });

  it("rejects cross-map layers and identities from other worlds atomically", async () => {
    const sameWorld = await createMap("Второй атлас того же мира");
    const before = await state();
    for (const layerId of [sameWorld.layers[0].id, foreignMap.layers[0].id, randomUUID()]) {
      expect((await save({ features: [{ op: "create", id: randomUUID(), data: featureData(layerId) }] })).status).toBe(400);
    }
    const invalidId = await save({ features: [{ op: "create", id: foreignMap.map.id, data: featureData(political().id) }] });
    expect(invalidId.status).toBe(409);
    const wrongTimeline = await owner.call("GET", `/maps/${map.map.id}${scope(foreignMap.map.id)}`);
    expect(wrongTimeline.status).toBe(404);
    expect(await state()).toEqual(before);
  });

  it("merges polygons through PostGIS without saving an implicit change and then stores the explicit draft", async () => {
    const first = await addFeature({ name: "Западная земля", geometry: rectangle(100, 100, 200, 200) });
    const second = await addFeature({ name: "Восточная земля", geometry: rectangle(300, 100, 200, 200) });
    const before = await state();
    const merged = await owner.call<{ geometry: MapGeometry }>("POST", `/maps/${map.map.id}/geometry/merge${scope(main.id, "10")}`, { geometries: [first.geometry, second.geometry] });
    expect(merged.status, JSON.stringify(merged.data)).toBe(200);
    const area = await database.query<{ area: number }>("SELECT ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),0)) AS area", [JSON.stringify(merged.data.geometry)]);
    expect(area.rows[0].area).toBe(80000);
    expect(await state()).toEqual(before);
    const saved = await save({ features: [{ op: "update", id: first.id, version: first.version, data: featureInput(first, { geometry: merged.data.geometry, name: "Единая земля" }) }, { op: "delete", id: second.id, version: second.version }] });
    expect(saved.status).toBe(200); expect(saved.data.features).toHaveLength(1); expect(saved.data.features[0].id).toBe(first.id);
  });

  it("splits polygon territory with a true cutter and rejects non-crossing, foreign and invalid previews", async () => {
    const geometry = rectangle(100, 100, 400, 300), before = await state();
    const split = await owner.call<{ geometries: MapGeometry[] }>("POST", `/maps/${map.map.id}/geometry/split${scope(main.id, "10")}`, { geometry, cutter: { type: "LineString", coordinates: [[300, 50], [300, 450]] } });
    expect(split.status, JSON.stringify(split.data)).toBe(200); expect(split.data.geometries).toHaveLength(2);
    const areas = await database.query<{ area: number }>("SELECT sum(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON(value),0))) AS area FROM jsonb_array_elements($1::jsonb)", [JSON.stringify(split.data.geometries)]);
    expect(areas.rows[0].area).toBe(120000);
    expect(await state()).toEqual(before);
    const miss = await owner.call("POST", `/maps/${map.map.id}/geometry/split${scope(main.id, "10")}`, { geometry, cutter: { type: "LineString", coordinates: [[600, 50], [600, 450]] } });
    expect(miss.status).toBe(400);
    const outside = await owner.call("POST", `/maps/${map.map.id}/geometry/merge${scope(main.id, "10")}`, { geometries: [geometry, rectangle(900, 100, 200, 200)] });
    expect(outside.status).toBe(400);
    const invisible = await owner.call("POST", `/maps/${foreignMap.map.id}/geometry/split`, { geometry, cutter: { type: "LineString", coordinates: [[300, 50], [300, 450]] } });
    expect(invisible.status).toBe(404);
  });

  it("updates map metadata historically while preserving dimensions and rejecting stale or fixed-revision writes", async () => {
    const before = await state();
    const changed = await owner.call<MapData>("PATCH", `/maps/${map.map.id}${scope(main.id, "20")}`, { version: map.map.version, name: "Атлас после реформы", background: "#233d50" });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    expect((await state(main.id, "15")).map.name).toBe(before.map.name);
    expect((await state(main.id, "20")).map).toMatchObject({ name: "Атлас после реформы", width: 1000, height: 700, background: "#233d50" });
    expect((await owner.call("PATCH", `/maps/${map.map.id}${scope(main.id, "20")}`, { version: map.map.version, name: "Устаревшее имя" })).status).toBe(409);
    expect((await owner.call("PATCH", `/maps/${map.map.id}${scope(main.id, "20")}`, { version: changed.data.map.version, width: 1200 })).status).toBe(400);
    expect((await owner.call("PATCH", `/maps/${map.map.id}${scope(main.id, "20", before.revision)}`, { version: changed.data.map.version, name: "Запрещённая запись" })).status).toBe(400);
  });

  it("isolates private maps and enforces reader-only access for every editor endpoint", async () => {
    const feature = await addFeature();
    expect((await anonymous.call("GET", `/maps/${map.map.id}`)).status).toBe(401);
    for (const path of [`/worlds/${world.id}/maps`, `/maps/${map.map.id}`, `/map-features/${feature.id}/history`]) expect((await stranger.call("GET", path)).status).toBe(404);
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, readerId]);
    try {
      expect((await reader.call("GET", `/maps/${map.map.id}`)).status).toBe(200);
      const current = await state();
      const attempts: [string, string, unknown][] = [
        ["POST", `/worlds/${world.id}/maps`, { name: "Запрещённая карта", description: "", width: 1000, height: 700, background: "#102030" }],
        ["PATCH", `/maps/${map.map.id}`, { version: map.map.version, name: "Запрещённая правка" }],
        ["DELETE", `/maps/${map.map.id}`, { version: map.map.version }],
        ["PUT", `/maps/${map.map.id}/content`, { expectedRevision: current.revision, layers: [], features: [{ op: "delete", id: feature.id, version: feature.version }] }],
        ["POST", `/maps/${map.map.id}/geometry/merge`, { geometries: [rectangle(), rectangle(300)] }],
        ["POST", `/maps/${map.map.id}/geometry/split`, { geometry: rectangle(), cutter: { type: "LineString", coordinates: [[200, 50], [200, 350]] } }],
      ];
      for (const [method, path, input] of attempts) expect((await reader.call(method, path, input)).status).toBe(403);
      expect(await state()).toEqual(current);
    } finally { await database.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [project.id, readerId]); }
  });

  it("keeps geographic facts out of legacy lore lists and comparisons without changing old character facts", async () => {
    const created = await owner.call<{ character: Character }>("POST", `/worlds/${world.id}/characters${scope(main.id, "10")}`, { name: "Картограф прежнего лора", biography: "Биография сохранена" });
    expect(created.status).toBe(201);
    const old = await database.query("SELECT revision::text,data,version FROM lore_revisions WHERE object_id=$1 ORDER BY revision", [created.data.character.id]);
    const hash = createHash("sha256").update(JSON.stringify(old.rows)).digest("hex");
    const feature = await addFeature(), branch = await fork();
    expect((await save({ features: [{ op: "update", id: feature.id, version: feature.version, data: featureInput(feature, { geometry: rectangle(500, 300), name: "Другая политика" }) }] }, branch.id, "20")).status).toBe(200);
    const lore = await owner.call<WorldData>("GET", `/worlds/${world.id}${scope(branch.id)}`);
    expect(lore.data.characters).toHaveLength(1); expect(lore.data.characters[0].id).toBe(created.data.character.id);
    expect(lore.data.events).toEqual([]); expect(lore.data.relations).toEqual([]);
    const compared = await owner.call<{ differences: unknown[] }>("GET", `/timelines/${main.id}/compare?other=${branch.id}`);
    expect(compared.status, JSON.stringify(compared.data)).toBe(200); expect(compared.data.differences).toEqual([]);
    const preserved = await database.query("SELECT revision::text,data,version FROM lore_revisions WHERE object_id=$1 ORDER BY revision", [created.data.character.id]);
    expect(createHash("sha256").update(JSON.stringify(preserved.rows)).digest("hex")).toBe(hash);
  });
});
