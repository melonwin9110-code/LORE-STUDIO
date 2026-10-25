import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Project, User, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { AtlasMap, MapData, MapFeature, MapFeatureInput, MapGeometry } from "../../src/lib/map-types";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
const origin = new URL(base).origin;
const databaseURL = process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(new URL(databaseURL).pathname.slice(1)))) throw new Error("Map generation checks require a dedicated *_test database");
const database = new pg.Pool({ connectionString: databaseURL });
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
type GenerationInput = { name: string; description?: string; width?: number; height?: number; background?: string; seed: string; preset: "island" | "continents" | "archipelago" };
class Client {
  cookie = "";
  async call<T = { error?: string }>(method: string, path: string, input?: unknown, requestOrigin = origin) {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { Origin: requestOrigin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    return { status: response.status, data: await response.json() as T };
  }
}
const scope = (timeline: string, day?: string) => `?${new URLSearchParams({ timeline, ...(day === undefined ? {} : { day }) })}`;
const featureInput = (feature: MapFeature): MapFeatureInput => ({ name: feature.name, kind: feature.kind, layerId: feature.layerId, geometry: feature.geometry, description: feature.description, fill: feature.fill, stroke: feature.stroke, strokeWidth: feature.strokeWidth, label: feature.label, eventId: feature.eventId, parentId: feature.parentId });
function canonicalGeography(map: MapData) {
  const layers = new Map(map.layers.map((layer) => [layer.id, layer.name]));
  const features = new Map(map.features.map((feature) => [feature.id, feature.name]));
  return {
    layers: map.layers.map(({ name, kind, visible, locked, opacity, order }) => ({ name, kind, visible, locked, opacity, order })).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    features: map.features.map((feature) => ({ ...featureInput(feature), layerId: layers.get(feature.layerId), parentId: feature.parentId ? features.get(feature.parentId) : null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

describe("map generation 0.5: editable geography, deterministic seeds and isolated creation", () => {
  const owner = new Client(), stranger = new Client(), reader = new Client(), anonymous = new Client();
  let project: Project, foreignProject: Project, readerId: string;
  let world: World, main: Timeline;
  const input = (extra: Partial<GenerationInput> = {}): GenerationInput => ({ name: "Готовая основа мира", description: "Редактируемая география для проверки", width: 1000, height: 700, background: "#173949", seed: "lore-api-seed-2026", preset: "island", ...extra });
  const path = (worldId = world.id, timeline = main.id, day = "10") => `/worlds/${worldId}/maps/generate${scope(timeline, day)}`;
  async function generate(extra: Partial<GenerationInput> = {}, timeline = main.id, day = "10") {
    const result = await owner.call<MapData>("POST", path(world.id, timeline, day), input(extra));
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data;
  }
  async function list(timeline = main.id, day?: string) {
    const result = await owner.call<{ maps: AtlasMap[]; revision: string }>("GET", `/worlds/${world.id}/maps${scope(timeline, day)}`);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data;
  }
  async function load(mapId: string, timeline = main.id, day?: string) {
    return owner.call<MapData>("GET", `/maps/${mapId}${scope(timeline, day)}`);
  }
  async function fork(day = "15") {
    const state = await owner.call<WorldData>("GET", `/worlds/${world.id}${scope(main.id)}`);
    const result = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: "Ветка собственной географии", parentId: main.id, forkDay: day, expectedParentRevision: state.data.history!.timeline.headRevision });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data.timeline;
  }
  beforeAll(async () => {
    for (const [client, name] of [[owner, "owner"], [stranger, "stranger"], [reader, "reader"]] as const) {
      const registered = await client.call<{ user: User }>("POST", "/auth/register", { name, email: `generation-${name}-${suffix}@example.test`, password: "Generation-api-password-2026!" });
      expect(registered.status).toBe(201);
      if (client === reader) readerId = registered.data.user.id;
    }
    const own = await owner.call<{ project: Project }>("POST", "/projects", { name: `Генерация собственной географии ${suffix}` });
    expect(own.status).toBe(201); project = own.data.project;
    const other = await stranger.call<{ project: Project }>("POST", "/projects", { name: `Чужая география ${suffix}` });
    expect(other.status).toBe(201); foreignProject = other.data.project;
  }, 60000);
  beforeEach(async () => {
    const created = await owner.call<{ world: World }>("POST", `/projects/${project.id}/worlds`, { name: "Мир отдельной проверки основы" });
    expect(created.status).toBe(201); world = created.data.world;
    const state = await owner.call<WorldData>("GET", `/worlds/${world.id}`);
    expect(state.status).toBe(200); main = state.data.history!.timeline;
  });
  afterAll(async () => {
    if (project) await owner.call("DELETE", `/projects/${project.id}`);
    if (foreignProject) await stranger.call("DELETE", `/projects/${foreignProject.id}`);
    await owner.call("POST", "/auth/logout"); await stranger.call("POST", "/auth/logout"); await reader.call("POST", "/auth/logout");
    await database.end();
  });

  it("creates all three presets as valid, bounded PostGIS geography with real editable layers and references", async () => {
    for (const preset of ["island", "continents", "archipelago"] as const) {
      const map = await generate({ preset });
      expect(map.map).toMatchObject({ worldId: world.id, name: input().name, width: 1000, height: 700 });
      expect(map.features.length).toBeGreaterThan(3);
      expect(map.features.length + map.layers.length).toBeLessThanOrEqual(200);
      const ids = new Set(map.features.map((feature) => feature.id)), layerIds = new Set(map.layers.map((layer) => layer.id));
      expect(ids.size).toBe(map.features.length);
      expect(map.features.some((feature) => feature.kind === "continent" || feature.kind === "island")).toBe(true);
      expect(map.features.some((feature) => feature.kind === "river")).toBe(true);
      expect(map.features.some((feature) => feature.kind === "forest")).toBe(true);
      for (const feature of map.features) {
        expect(feature.mapId).toBe(map.map.id); expect(feature.version).toBe(1);
        expect(layerIds.has(feature.layerId)).toBe(true);
        if (feature.parentId) expect(ids.has(feature.parentId)).toBe(true);
      }
      const spatial = await database.query<{ count: number; valid: boolean; same: boolean; bounded: boolean; srid: boolean }>(`SELECT count(*)::integer AS count,
        bool_and(ST_IsValid(geometry) AND ST_IsSimple(geometry) AND NOT ST_IsEmpty(geometry)) AS valid,
        bool_and(ST_Equals(geometry,ST_SetSRID(ST_GeomFromGeoJSON(data->'geometry'),0))) AS same,
        bool_and(ST_CoveredBy(geometry,ST_MakeEnvelope(0,0,1000,700,0))) AS bounded,
        bool_and(ST_SRID(geometry)=0) AS srid
        FROM lore_revisions WHERE object_id=ANY($1::uuid[])`, [[...ids]]);
      expect(spatial.rows[0]).toEqual({ count: map.features.length, valid: true, same: true, bounded: true, srid: true });
      const inland = await database.query<{ outside: number }>(`WITH land AS (
        SELECT ST_UnaryUnion(ST_Collect(geometry)) AS geometry FROM lore_revisions
        WHERE object_id=ANY($1::uuid[]) AND data->>'kind' IN ('continent','island')
      ) SELECT count(*)::integer AS outside FROM lore_revisions r CROSS JOIN land
      WHERE r.object_id=ANY($1::uuid[]) AND r.data->>'kind' IN ('forest','lake') AND NOT ST_CoveredBy(r.geometry,land.geometry)`, [[...ids]]);
      expect(inland.rows[0].outside).toBe(0);
      const rivers = await database.query<{ outside: number; bad_mouth: number }>(`WITH land AS (
        SELECT ST_UnaryUnion(ST_Collect(geometry)) AS geometry FROM lore_revisions
        WHERE object_id=ANY($1::uuid[]) AND data->>'kind' IN ('continent','island')
      ) SELECT count(*) FILTER(WHERE NOT ST_CoveredBy(r.geometry,land.geometry))::integer AS outside,
        count(*) FILTER(WHERE r.data->>'name' LIKE 'Река %' AND ST_Distance(ST_EndPoint(r.geometry),ST_Boundary(land.geometry))>0.000001)::integer AS bad_mouth
      FROM lore_revisions r CROSS JOIN land WHERE r.object_id=ANY($1::uuid[]) AND r.data->>'kind'='river'`, [[...ids]]);
      expect(rivers.rows[0]).toEqual({ outside: 0, bad_mouth: 0 });
    }
  }, 60000);

  it("reproduces geography for the same seed while each map receives distinct stable identities", async () => {
    const first = await generate(), repeated = await generate({ name: "Другая копия того же seed" });
    expect(first.map).toMatchObject({ generation: { seed: input().seed, preset: "island", algorithmVersion: "lore-base-1" } });
    expect((await load(first.map.id)).data.map).toMatchObject({ generation: { seed: input().seed, preset: "island", algorithmVersion: "lore-base-1" } });
    expect(repeated.map.id).not.toBe(first.map.id);
    expect(new Set(first.features.map((feature) => feature.id).filter((id) => repeated.features.some((feature) => feature.id === id))).size).toBe(0);
    expect(canonicalGeography(repeated)).toEqual(canonicalGeography(first));
    const changed = await generate({ seed: "another-coastline-seed" });
    expect(changed.features.filter((feature) => feature.kind === "continent" || feature.kind === "island").map((feature) => feature.geometry)).not.toEqual(first.features.filter((feature) => feature.kind === "continent" || feature.kind === "island").map((feature) => feature.geometry));
  }, 60000);

  it("creates a new atlas without overwriting existing maps, and blank maps remain genuinely empty", async () => {
    const blank = await owner.call<MapData>("POST", `/worlds/${world.id}/maps${scope(main.id, "10")}`, { name: "Мой пустой мир" });
    expect(blank.status).toBe(201); expect(blank.data.features).toEqual([]);
    const existing = await generate({ name: "Основа, которую нужно сохранить" });
    const extra = await generate({ name: "Совсем новая основа", preset: "archipelago", seed: "other-private-atlas" });
    const after = await load(existing.map.id);
    expect(after.status).toBe(200);
    expect(after.data.map).toEqual(existing.map); expect(after.data.layers).toEqual(existing.layers); expect(after.data.features).toEqual(existing.features);
    expect((await load(blank.data.map.id)).data.features).toEqual([]);
    expect(new Set((await list()).maps.map((map) => map.id))).toEqual(new Set([blank.data.map.id, existing.map.id, extra.map.id]));
  });

  it("lets generated objects be edited and saved with normal versioned map transactions", async () => {
    const generated = await generate();
    const original = generated.features.find((feature) => feature.geometry.type === "Polygon")!;
    const previousGeometry = original.geometry as Extract<MapGeometry, { type: "Polygon" }>;
    const geometry: MapGeometry = { type: "Polygon", coordinates: previousGeometry.coordinates.map((ring) => ring.map(([x, y]) => [x + 1, y + 1])) };
    const edited = { ...featureInput(original), geometry, name: "Перерисованная автором земля", fill: "#22bb66", stroke: "#bb2255", strokeWidth: 4 };
    const result = await owner.call<MapData>("PUT", `/maps/${generated.map.id}/content${scope(main.id, "20")}`, { expectedRevision: generated.revision, layers: [], features: [{ op: "update", id: original.id, version: original.version, data: edited }] });
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    const reread = await load(generated.map.id, main.id, "20");
    expect(reread.data.features.find((feature) => feature.id === original.id)).toMatchObject({ ...edited, id: original.id, version: 2 });
    expect(reread.data.features.find((feature) => feature.id === original.id)!.geometry).not.toEqual(original.geometry);
    const earlier = await load(generated.map.id, main.id, "10");
    expect(earlier.data.features.find((feature) => feature.id === original.id)).toEqual(original);
  });

  it("honors historical dates and pinned forks without adding a generated map to other timelines", async () => {
    const inherited = await generate();
    expect((await list(main.id, "9")).maps).toEqual([]);
    const branch = await fork();
    const mainOnly = await generate({ name: "Поздно созданный материк" }, main.id, "20");
    expect((await load(mainOnly.map.id, branch.id)).status).toBe(404);
    const branchOnly = await generate({ name: "География дочерней истории" }, branch.id, "20");
    expect((await load(branchOnly.map.id, main.id)).status).toBe(404);
    expect((await load(inherited.map.id, branch.id)).data.features).toEqual(inherited.features);
    const beforeFork = await owner.call("POST", path(world.id, branch.id, "14"), input());
    expect(beforeFork.status).toBe(400);
    expect(new Set((await list(branch.id)).maps.map((map) => map.id))).toEqual(new Set([inherited.map.id, branchOnly.map.id]));
  }, 60000);

  it("rejects invalid generator settings atomically without leaving empty maps or identities", async () => {
    const before = await list();
    const count = Number((await database.query("SELECT count(*) AS total FROM lore_objects WHERE world_id=$1", [world.id])).rows[0].total);
    const invalids = [{ seed: "" }, { seed: "   " }, { seed: "x".repeat(129) }, { seed: 123 }, { preset: "unknown" }, { width: 99 }, { height: 100001 }, { width: 1000.5 }, { mapId: randomUUID() }];
    for (const extra of invalids) {
      const result = await owner.call("POST", path(), { ...input(), ...extra });
      expect(result.status, JSON.stringify(result.data)).toBe(400);
      expect(await list()).toEqual(before);
    }
    expect(Number((await database.query("SELECT count(*) AS total FROM lore_objects WHERE world_id=$1", [world.id])).rows[0].total)).toBe(count);
  });

  it("requires editor access and never exposes another project's generated geography", async () => {
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, readerId]);
    try {
      expect((await anonymous.call("POST", path(), input())).status).toBe(401);
      expect((await stranger.call("POST", path(), input())).status).toBe(404);
      expect((await reader.call("POST", path(), input())).status).toBe(403);
      expect((await list()).maps).toEqual([]);
      const generated = await generate();
      expect((await stranger.call("GET", `/maps/${generated.map.id}`)).status).toBe(404);
      const readable = await reader.call<MapData>("GET", `/maps/${generated.map.id}`);
      expect(readable.status).toBe(200); expect(readable.data.features).toEqual(generated.features);
    } finally { await database.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [project.id, readerId]); }
  });

  it("supports one-click creation without a seed and retains the chosen generation settings after reload", async () => {
    const created = await owner.call<MapData>("POST", path(), { name: "Основа одним нажатием" });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const metadata = (created.data.map as AtlasMap & { generation: { seed: string; preset: string; algorithmVersion: string } }).generation;
    expect(metadata.seed.trim().length).toBeGreaterThan(0);
    expect(metadata.seed.length).toBeLessThanOrEqual(128);
    expect(metadata).toMatchObject({ preset: "island", algorithmVersion: "lore-base-1" });
    expect((await load(created.data.map.id)).data.map).toMatchObject({ generation: metadata });
    const replay = await generate({ seed: metadata.seed });
    expect(canonicalGeography(replay)).toEqual(canonicalGeography(created.data));
  });

  it("rejects foreign origins, pinned-revision writes and foreign timeline contexts before creating data", async () => {
    expect((await owner.call("POST", path(), input(), "https://another-origin.example")).status).toBe(403);
    expect((await owner.call("POST", `${path()}&revision=0`, input())).status).toBe(400);
    const foreign = await stranger.call<{ world: World }>("POST", `/projects/${foreignProject.id}/worlds`, { name: "Чужой временной контекст" });
    const state = await stranger.call<WorldData>("GET", `/worlds/${foreign.data.world.id}`);
    expect((await owner.call("POST", path(world.id, state.data.history!.timeline.id), input())).status).toBe(404);
    expect((await list()).maps).toEqual([]);
  });
});
