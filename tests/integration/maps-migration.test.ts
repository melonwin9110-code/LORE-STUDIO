import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import sharp from "sharp";
import { getFamily } from "../../src/server/family";
import { loadWorld } from "../../src/server/history";
import { getPortrait } from "../../src/server/portraits";
import { getTimelineGraph } from "../../src/server/timeline-graph";

const target = new URL(process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test");
if (!/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(target.pathname.slice(1)))) {
  throw new Error("Map migration checks require a dedicated *_test database");
}
const adminURL = new URL(target); adminURL.pathname = "/postgres";
const fixtureName = `lore_maps_${randomUUID().replaceAll("-", "")}_test`;
target.pathname = `/${fixtureName}`;
const admin = new pg.Client({ connectionString: adminURL.toString() });
const pool = new pg.Pool({ connectionString: target.toString() });
const ids = Object.fromEntries(["user", "project", "world", "parent", "child", "pair", "event", "family", "crossing"].map((key) => [key, randomUUID()]));
let client: pg.PoolClient, created = false, main = "", branch = "", pinnedRevision = "", originalFacts = "";
let oldSnapshot: Record<string, unknown>, portraitBytes: Buffer;

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
  // Explicit pre-006 columns ensure adding geometry does not itself change the
  // comparison; every old payload, timestamp, version and actor must survive.
  return digest((await client.query(`SELECT revision::text,object_id,world_id,timeline_id,effective_day::text,
    version,deleted,data,actor_id,created_at::text FROM lore_revisions ORDER BY revision`)).rows);
}
async function snapshot() {
  const tables = ["users", "sessions", "projects", "project_members", "worlds", "lore_objects", "timelines", "world_calendars", "world_family_state", "family_relations", "family_legacy_sources", "character_portraits", "timeline_graph_state", "timeline_connections", "audit_log"];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    // Table names are fixed test constants. JSON sorting makes this independent
    // of physical row order, including the bytea image's exact encoded bytes.
    const rows = (await client.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    result[table] = rows.map((row) => row.data);
  }
  return result;
}

describe("upgrade from 0.3 to PostGIS map storage without losing existing work", () => {
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${fixtureName}"`); created = true;
    client = await pool.connect();
    await client.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await migrate(["001_initial.sql"]);
    await client.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Автор до карт','maps-upgrade@example.test','unusable-migration-fixture-hash')", [ids.user]);
    await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", ["migration-fixture-token-hash", ids.user]);
    await client.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Сохранённый проект 0.3')", [ids.project, ids.user]);
    await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [ids.project, ids.user]);
    await client.query("INSERT INTO worlds(id,project_id,name) VALUES($1,$2,'Мир до атласа')", [ids.world, ids.project]);
    const profile = (name: string, birthYear: number) => ({ name, title: "", species: "Человек", gender: "", birthYear, deathYear: null, appearance: "", personality: "", biography: `Биография до карт: ${name}`, motivation: "", abilities: "", secrets: "", status: "canon" });
    const parentProfile = profile("Старший хранитель", 0);
    await client.query("INSERT INTO characters(id,world_id,data,version) VALUES($1,$2,$3,7),($4,$2,$5,4)", [ids.parent, ids.world, JSON.stringify(parentProfile), ids.child, JSON.stringify(profile("Младший хранитель", 30))]);
    await client.query("INSERT INTO relations(id,world_id,from_id,to_id,data,version) VALUES($1,$2,$3,$4,$5,5)", [ids.pair, ids.world, ids.parent, ids.child, JSON.stringify({ kind: "Союз", mutual: true, startYear: null, endYear: null, description: "Сохранённое парное отношение" })]);
    await client.query("INSERT INTO events(id,world_id,data,version) VALUES($1,$2,$3,3)", [ids.event, ids.world, JSON.stringify({ name: "Событие до атласа", type: "Договор", startYear: 100, endYear: null, description: "История уже существует", status: "canon" })]);
    await client.query("INSERT INTO event_participants(event_id,character_id,world_id) VALUES($1,$2,$3)", [ids.event, ids.parent, ids.world]);
    await migrate(["002_history.sql", "003_family_groups.sql", "004_portraits.sql", "005_timeline_graph.sql"]);
    const root = (await client.query("SELECT id,head_revision::text FROM timelines WHERE world_id=$1 AND is_main", [ids.world])).rows[0];
    main = root.id; pinnedRevision = root.head_revision;
    branch = (await client.query("INSERT INTO timelines(world_id,name,parent_id,parent_revision,fork_day) VALUES($1,'Закреплённое ответвление',$2,$3,100) RETURNING id", [ids.world, main, pinnedRevision])).rows[0].id;
    // A backdated parent edit made after the fork must stay out of its pinned
    // inherited biography both before and after the map migration.
    const later = (await client.query("INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,data,actor_id) VALUES($1,$2,$3,20,8,$4,$5) RETURNING revision::text", [ids.parent, ids.world, main, JSON.stringify({ ...parentProfile, biography: "Поздняя правка основной истории" }), ids.user])).rows[0].revision;
    await client.query("UPDATE lore_objects SET version=8,portrait_version=3 WHERE id=$1", [ids.parent]);
    await client.query("UPDATE timelines SET head_revision=$1 WHERE id=$2", [later, main]);
    await client.query("INSERT INTO family_relations(id,world_id,from_id,to_id,family_kind,description,version) VALUES($1,$2,$3,$4,'parent','Общая семья версии 0.3',3)", [ids.family, ids.world, ids.parent, ids.child]);
    await client.query("UPDATE world_family_state SET version=4 WHERE world_id=$1", [ids.world]);
    portraitBytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 90, g: 55, b: 145 } } }).webp().toBuffer();
    await client.query("INSERT INTO character_portraits(character_id,world_id,content_type,image_data,width,height) VALUES($1,$2,'image/webp',$3,12,8)", [ids.parent, ids.world, portraitBytes]);
    await client.query("UPDATE timeline_graph_state SET version=6,positions=$1,viewport=$2,updated_by=$3 WHERE world_id=$4", [JSON.stringify({ [main]: { x: 30, y: -12 }, [branch]: { x: 450, y: 185 } }), JSON.stringify({ x: 25, y: -40, zoom: 0.8 }), ids.user, ids.world]);
    await client.query("INSERT INTO timeline_connections(id,world_id,source_id,target_id,kind,label) VALUES($1,$2,$3,$4,'influence','Переплетение до появления карт')", [ids.crossing, ids.world, main, branch]);
    await client.query("INSERT INTO audit_log(project_id,actor_id,entity_type,entity_id,action,snapshot) VALUES($1,$2,'family_relation',$3,'create',$4)", [ids.project, ids.user, ids.family, JSON.stringify({ beforeMaps: true })]);
    originalFacts = await factsHash(); oldSnapshot = await snapshot();
    await migrate(["006_maps.sql"]);
  }, 30000);

  afterAll(async () => {
    client?.release(); await pool.end();
    if (created) await admin.query(`DROP DATABASE "${fixtureName}"`);
    await admin.end();
  });

  it("keeps accounts, immutable facts, versions, portraits, world family and timeline layout unchanged", async () => {
    expect(await factsHash()).toBe(originalFacts);
    expect(await snapshot()).toEqual(oldSnapshot);
    const root = await loadWorld(client, ids.user, ids.world, { timelineId: main });
    const fork = await loadWorld(client, ids.user, ids.world, { timelineId: branch });
    expect(root.characters.find((person) => person.id === ids.parent)).toMatchObject({ id: ids.parent, version: 8, biography: "Поздняя правка основной истории", portraitUrl: `/api/characters/${ids.parent}/portrait?v=3` });
    expect(fork.characters.find((person) => person.id === ids.parent)).toMatchObject({ id: ids.parent, version: 7, biography: "Биография до карт: Старший хранитель" });
    expect(fork.history!.timeline).toMatchObject({ parentId: main, parentRevision: pinnedRevision, forkDay: "100" });
    expect(root.relations[0]).toMatchObject({ id: ids.pair, version: 5, fromId: ids.parent, toId: ids.child, participantIds: [ids.parent, ids.child] });
    expect(root.events[0]).toMatchObject({ id: ids.event, version: 3, characterIds: [ids.parent] });
    const family = await getFamily(client, ids.user, ids.world);
    expect(family).toMatchObject({ version: 4, migration: null });
    expect(family.relations).toHaveLength(1);
    expect(family.relations[0]).toMatchObject({ id: ids.family, fromId: ids.parent, toId: ids.child, version: 3, familyKind: "parent" });
    const portrait = await getPortrait(client, ids.user, ids.parent);
    expect(portrait?.bytes).toEqual(portraitBytes);
    expect(portrait?.contentType).toBe("image/webp");
    expect(await sharp(portrait!.bytes).metadata()).toMatchObject({ width: 12, height: 8, format: "webp" });
    const graph = await getTimelineGraph(client, ids.user, ids.world);
    expect(graph).toMatchObject({ version: 6, positions: { [main]: { x: 30, y: -12 }, [branch]: { x: 450, y: 185 } }, viewport: { x: 25, y: -40, zoom: 0.8 } });
    expect(graph.connections).toEqual([{ id: ids.crossing, sourceId: main, targetId: branch, kind: "influence", label: "Переплетение до появления карт" }]);
  });

  it("repeats the upgrade safely while retaining old revision protection and adding spatial storage", async () => {
    await migrate(["006_maps.sql"]);
    expect((await client.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name='006_maps.sql'")).rows[0].count).toBe(1);
    expect(await factsHash()).toBe(originalFacts);
    expect(await snapshot()).toEqual(oldSnapshot);
    expect((await client.query("SELECT count(*)::int AS count FROM lore_revisions WHERE geometry IS NOT NULL")).rows[0].count).toBe(0);
    expect((await client.query("SELECT Find_SRID('public','lore_revisions','geometry') AS srid")).rows[0].srid).toBe(0);
    expect((await client.query("SELECT type,coord_dimension,srid FROM geometry_columns WHERE f_table_schema='public' AND f_table_name='lore_revisions' AND f_geometry_column='geometry'")).rows[0]).toMatchObject({ type: "GEOMETRY", coord_dimension: 2, srid: 0 });
    expect((await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='lore_revisions_geometry_idx'")).rows[0].indexdef).toMatch(/USING gist \(geometry\)/);
    await expect(client.query("UPDATE lore_revisions SET data='{}'::jsonb WHERE object_id=$1", [ids.parent])).rejects.toThrow(/immutable/i);
    await expect(client.query("DELETE FROM lore_revisions WHERE object_id=$1", [ids.parent])).rejects.toThrow(/immutable/i);
    expect(await factsHash()).toBe(originalFacts);
  });
});
