import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import sharp from "sharp";
import { loadWorld } from "../../src/server/history";
import { getFamily } from "../../src/server/family";
import { getPortrait } from "../../src/server/portraits";
import { createMap, getMap, saveMapContent } from "../../src/server/maps";

const target = new URL(process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test");
if (!/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(target.pathname.slice(1)))) throw new Error("Wiki migration checks require a dedicated *_test database");
const adminURL = new URL(target); adminURL.pathname = "/postgres";
const fixtureName = `lore_wiki_${randomUUID().replaceAll("-", "")}_test`;
target.pathname = `/${fixtureName}`;
const admin = new pg.Client({ connectionString: adminURL.toString() });
const pool = new pg.Pool({ connectionString: target.toString() });
const ids = Object.fromEntries(["user", "project", "world", "parent", "child", "relation", "event", "family", "geography"].map((key) => [key, randomUUID()]));
let client: pg.PoolClient, created = false, main = "", branch = "", mapId = "", pinnedRevision = "", oldFacts = "";
let oldSnapshot: Record<string, unknown>, portrait: Buffer;

async function migrate(names: string[]) {
  for (const name of names) {
    if ((await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name])).rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(`db/migrations/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function factsHash() {
  return digest((await client.query(`SELECT revision::text,object_id,world_id,timeline_id,effective_day::text,version,deleted,data,actor_id,created_at::text,
    encode(ST_AsEWKB(geometry),'hex') AS geometry FROM lore_revisions ORDER BY revision`)).rows);
}
async function snapshot() {
  const tables = ["users", "sessions", "projects", "project_members", "worlds", "lore_objects", "timelines", "world_calendars", "world_family_state", "family_relations", "family_legacy_sources", "character_portraits", "timeline_graph_state", "timeline_connections", "audit_log"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await client.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map((row) => row.data);
  return result;
}

describe("upgrade from historical maps 0.5 to Wiki without changing existing worlds", () => {
  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE "${fixtureName}"`); created = true;
    client = await pool.connect();
    await client.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await migrate(["001_initial.sql"]);
    await client.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'ElpisHeart upgrade fixture','wiki-upgrade@example.test','unusable-fixture-password-hash')", [ids.user]);
    await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('wiki-upgrade-fixture-token',$1,now()+interval '1 day')", [ids.user]);
    await client.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Мир до энциклопедии')", [ids.project, ids.user]);
    await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [ids.project, ids.user]);
    await client.query("INSERT INTO worlds(id,project_id,name) VALUES($1,$2,'Сохранённые карты и биографии')", [ids.world, ids.project]);
    const profile = (name: string, birthYear: number) => ({ name, title: "", species: "Человек", gender: "", birthYear, deathYear: null, appearance: "", personality: "", biography: `Биография до Wiki: ${name}`, motivation: "", abilities: "", secrets: "", status: "canon" });
    const parent = profile("Старший хранитель", 0);
    await client.query("INSERT INTO characters(id,world_id,data,version) VALUES($1,$2,$3,7),($4,$2,$5,4)", [ids.parent, ids.world, JSON.stringify(parent), ids.child, JSON.stringify(profile("Младший хранитель", 30))]);
    await client.query("INSERT INTO relations(id,world_id,from_id,to_id,data,version) VALUES($1,$2,$3,$4,$5,5)", [ids.relation, ids.world, ids.parent, ids.child, JSON.stringify({ kind: "Союз", mutual: true, startYear: null, endYear: null, description: "Сохранённая связь" })]);
    await client.query("INSERT INTO events(id,world_id,data,version) VALUES($1,$2,$3,3)", [ids.event, ids.world, JSON.stringify({ name: "Событие до Wiki", type: "Договор", startYear: 100, endYear: null, description: "Неизменяемое прошлое", status: "canon" })]);
    await client.query("INSERT INTO event_participants(event_id,character_id,world_id) VALUES($1,$2,$3)", [ids.event, ids.parent, ids.world]);
    await migrate(["002_history.sql", "003_family_groups.sql", "004_portraits.sql", "005_timeline_graph.sql", "006_maps.sql"]);
    main = (await client.query("SELECT id FROM timelines WHERE world_id=$1 AND is_main", [ids.world])).rows[0].id;
    await client.query("INSERT INTO family_relations(id,world_id,from_id,to_id,family_kind,description,version) VALUES($1,$2,$3,$4,'parent','Родство до Wiki',3)", [ids.family, ids.world, ids.parent, ids.child]);
    await client.query("UPDATE world_family_state SET version=4 WHERE world_id=$1", [ids.world]);
    portrait = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#8054ad" } }).webp().toBuffer();
    await client.query("INSERT INTO character_portraits(character_id,world_id,content_type,image_data,width,height) VALUES($1,$2,'image/webp',$3,12,8)", [ids.parent, ids.world, portrait]);
    await client.query("UPDATE lore_objects SET portrait_version=3 WHERE id=$1", [ids.parent]);
    await client.query("BEGIN");
    try {
      const map = await createMap(client, ids.user, ids.world, { name: "Атлас до Wiki", description: "Сохранённая география", width: 1000, height: 700, background: "#7fa5b2", generation: { seed: "pre-wiki-map", preset: "island", algorithmVersion: "lore-base-1" } }, { timelineId: main, day: "10" });
      mapId = map.map.id;
      await saveMapContent(client, ids.user, mapId, { expectedRevision: map.revision, layers: [], features: [{ op: "create", id: ids.geography, data: { name: "Существующий материк", kind: "continent", layerId: map.layers.find((layer) => layer.kind === "physical")!.id, geometry: { type: "Polygon", coordinates: [[[100, 100], [700, 100], [700, 500], [100, 500], [100, 100]]] }, description: "Не терять при обновлении", fill: "#b6bc91", stroke: "#eeddbb", strokeWidth: 2, label: true, eventId: ids.event, parentId: null } }] }, { timelineId: main, day: "10" });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    pinnedRevision = (await client.query("SELECT head_revision::text FROM timelines WHERE id=$1", [main])).rows[0].head_revision;
    branch = (await client.query("INSERT INTO timelines(world_id,name,parent_id,parent_revision,fork_day) VALUES($1,'Закреплённая история до Wiki',$2,$3,100) RETURNING id", [ids.world, main, pinnedRevision])).rows[0].id;
    await client.query("UPDATE timeline_graph_state SET version=6,positions=$1,viewport=$2,updated_by=$3 WHERE world_id=$4", [JSON.stringify({ [main]: { x: 12, y: 20 }, [branch]: { x: 350, y: 180 } }), JSON.stringify({ x: 10, y: -15, zoom: 0.9 }), ids.user, ids.world]);
    const revision = (await client.query("INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,data,actor_id) VALUES($1,$2,$3,20,8,$4,$5) RETURNING revision::text", [ids.parent, ids.world, main, JSON.stringify({ ...parent, biography: "Поздняя правка родителя до Wiki" }), ids.user])).rows[0].revision;
    await client.query("UPDATE lore_objects SET version=8 WHERE id=$1", [ids.parent]); await client.query("UPDATE timelines SET head_revision=$1 WHERE id=$2", [revision, main]);
    oldFacts = await factsHash(); oldSnapshot = await snapshot();
    await migrate(["007_wiki.sql"]);
  }, 30000);
  afterAll(async () => {
    client?.release(); await pool.end();
    if (created) await admin.query(`DROP DATABASE "${fixtureName}"`);
    await admin.end();
  });

  it("preserves every old table, immutable payload, portrait and PostGIS geometry byte for byte", async () => {
    expect(await factsHash()).toBe(oldFacts); expect(await snapshot()).toEqual(oldSnapshot);
    const root = await loadWorld(client, ids.user, ids.world, { timelineId: main });
    const inherited = await loadWorld(client, ids.user, ids.world, { timelineId: branch });
    expect(root.characters.find((character) => character.id === ids.parent)).toMatchObject({ version: 8, biography: "Поздняя правка родителя до Wiki", portraitUrl: `/api/characters/${ids.parent}/portrait?v=3` });
    expect(inherited.characters.find((character) => character.id === ids.parent)).toMatchObject({ version: 7, biography: "Биография до Wiki: Старший хранитель" });
    expect(inherited.history!.timeline).toMatchObject({ parentId: main, parentRevision: pinnedRevision, forkDay: "100" });
    const map = await getMap(client, ids.user, mapId, { timelineId: branch });
    expect(map.map).toMatchObject({ name: "Атлас до Wiki", generation: { seed: "pre-wiki-map", algorithmVersion: "lore-base-1" } });
    expect(map.features[0]).toMatchObject({ id: ids.geography, description: "Не терять при обновлении", geometry: { type: "Polygon" } });
    expect((await getFamily(client, ids.user, ids.world)).relations[0]).toMatchObject({ id: ids.family, version: 3, familyKind: "parent" });
    expect((await getPortrait(client, ids.user, ids.parent))?.bytes).toEqual(portrait);
  });

  it("repeats migration safely, keeps immutable protections and adds private historical image/search storage", async () => {
    await migrate(["007_wiki.sql"]);
    expect((await client.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='007_wiki.sql'")).rows[0].n).toBe(1);
    expect(await factsHash()).toBe(oldFacts); expect(await snapshot()).toEqual(oldSnapshot);
    expect((await client.query("SELECT count(*)::int AS n FROM wiki_images")).rows[0].n).toBe(0);
    expect((await client.query("SELECT indexdef FROM pg_indexes WHERE indexname='lore_revisions_wiki_text_idx'")).rows[0].indexdef).toMatch(/USING gin/);
    expect((await client.query("SELECT count(*)::int AS n FROM lore_objects WHERE kind='wiki_articles'")).rows[0].n).toBe(0);
    await expect(client.query("UPDATE lore_revisions SET data='{}' WHERE object_id=$1", [ids.geography])).rejects.toThrow(/immutable/i);
    await expect(client.query("DELETE FROM lore_revisions WHERE object_id=$1", [ids.geography])).rejects.toThrow(/immutable/i);
    expect(await factsHash()).toBe(oldFacts);
  });
});
