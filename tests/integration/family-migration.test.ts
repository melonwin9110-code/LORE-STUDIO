import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { getFamily, importFamily } from "../../src/server/family";
import { loadWorld } from "../../src/server/history";

const target = new URL(process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test");
if (!decodeURIComponent(target.pathname.slice(1)).endsWith("_test")) throw new Error("Family migration checks require a separate *_test database");
const adminURL = new URL(target); adminURL.pathname = "/postgres";
const fixtureName = `lore_family_${randomUUID().replaceAll("-", "")}_test`;
target.pathname = `/${fixtureName}`;
const admin = new pg.Client({ connectionString: adminURL.toString() });
const pool = new pg.Pool({ connectionString: target.toString() });
const ids = Object.fromEntries(["user","project","world","autoWorld","parentA","parentB","child","autoA","autoB","family","autoFamily"].map((name) => [name, randomUUID()]));
let client: pg.PoolClient, created = false, originalHash = "", main = "", childLine = "";

async function pending(names?: string[]) {
  const files = names || (await readdir("db/migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    if ((await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name])).rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(`db/migrations/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
}
async function factsHash() {
  const rows = (await client.query("SELECT revision::text,object_id,world_id,timeline_id,effective_day::text,version,deleted,data,actor_id,created_at::text FROM lore_revisions ORDER BY revision")).rows;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
async function inTransaction<T>(run: () => Promise<T>) {
  await client.query("BEGIN");
  try { const value = await run(); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}

describe("migration of old line-specific families to the independent world tree", () => {
  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE "${fixtureName}"`); created = true;
    client = await pool.connect();
    await client.query("CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await pending(["001_initial.sql"]);
    await client.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Автор','family-upgrade@example.test','unusable-fixture-hash')", [ids.user]);
    await client.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Проект до обновления')", [ids.project,ids.user]);
    await client.query("INSERT INTO project_members VALUES($1,$2,'owner')", [ids.project,ids.user]);
    for (const [worldId,name] of [[ids.world,"Различия родства"],[ids.autoWorld,"Одна семейная версия"]]) {
      await client.query("INSERT INTO worlds(id,project_id,name) VALUES($1,$2,$3)", [worldId,ids.project,name]);
    }
    const profile = (name: string, birthYear: number) => ({name,title:"",species:"Человек",gender:"",birthYear,deathYear:null,appearance:"",personality:"",biography:`Биография: ${name}`,motivation:"",abilities:"",secrets:"",status:"canon"});
    for (const [id,worldId,name,year] of [[ids.parentA,ids.world,"Первый родитель",0],[ids.parentB,ids.world,"Второй родитель",-5],[ids.child,ids.world,"Ребёнок",20],[ids.autoA,ids.autoWorld,"Первый супруг",10],[ids.autoB,ids.autoWorld,"Второй супруг",12]] as const) {
      await client.query("INSERT INTO characters(id,world_id,data,version) VALUES($1,$2,$3,7)", [id,worldId,JSON.stringify(profile(name,year))]);
    }
    await pending(["002_history.sql"]);
    main = (await client.query("SELECT id FROM timelines WHERE world_id=$1 AND is_main", [ids.world])).rows[0].id;
    const autoMain = (await client.query("SELECT id FROM timelines WHERE world_id=$1 AND is_main", [ids.autoWorld])).rows[0].id;
    async function append(id: string, worldId: string, lineId: string, from: string, to: string, kind: string, version: number, day: string) {
      await client.query("INSERT INTO lore_objects(id,world_id,kind,version) VALUES($1,$2,'relations',$3) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version", [id,worldId,version]);
      const data = {fromId:from,toId:to,kind:kind === "spouse" ? "Брак" : "Родитель",familyKind:kind,mutual:kind === "spouse",startYear:null,endYear:null,description:"Старая семейная связь"};
      const revision = (await client.query("INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,data,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING revision::text", [id,worldId,lineId,day,version,JSON.stringify(data),ids.user])).rows[0].revision;
      await client.query("UPDATE timelines SET head_revision=$1 WHERE id=$2", [revision,lineId]); return revision;
    }
    const parentHead = await append(ids.family,ids.world,main,ids.parentA,ids.child,"parent",1,"10");
    childLine = (await client.query("INSERT INTO timelines(world_id,name,parent_id,parent_revision,fork_day) VALUES($1,'Иное происхождение',$2,$3,1000) RETURNING id", [ids.world,main,parentHead])).rows[0].id;
    await append(ids.family,ids.world,childLine,ids.parentB,ids.child,"parent",2,"1000");
    await append(ids.autoFamily,ids.autoWorld,autoMain,ids.autoA,ids.autoB,"spouse",1,"10");
    originalHash = await factsHash();
    await pending();
  }, 30000);
  afterAll(async () => {
    client?.release(); await pool.end();
    if (created) await admin.query(`DROP DATABASE "${fixtureName}"`);
    await admin.end();
  });
  it("requires an explicit source for conflicting old branches, preserving all original immutable facts", async () => {
    const state = await inTransaction(() => getFamily(client,ids.user,ids.world));
    expect(state.migration?.required).toBe(true);
    expect(state.migration?.sources.map((source) => source.timelineId).sort()).toEqual([main,childLine].sort());
    expect(state.relations).toHaveLength(0);
    const chosen = await inTransaction(() => importFamily(client,ids.user,ids.world,{timelineId:childLine,expectedVersion:state.version}));
    expect(chosen.migration).toBeNull();
    expect(chosen.relations[0]).toMatchObject({id:ids.family,fromId:ids.parentB,toId:ids.child});
    const rootState = await loadWorld(client,ids.user,ids.world,{timelineId:main});
    expect(rootState.relations[0].fromId).toBe(ids.parentA);
    expect(rootState.characters.find((person) => person.id === ids.child)).toMatchObject({version:7,biography:"Биография: Ребёнок"});
    expect(await factsHash()).toBe(originalHash);
  });
  it("automatically retains a consistent family and repeating migration leaves the chosen tree intact", async () => {
    const family = await inTransaction(() => getFamily(client,ids.user,ids.autoWorld));
    expect(family.migration).toBeNull();
    expect(family.relations[0]).toMatchObject({id:ids.autoFamily,fromId:ids.autoA,toId:ids.autoB,familyKind:"spouse"});
    await pending();
    const chosen = await inTransaction(() => getFamily(client,ids.user,ids.world));
    expect(chosen.relations[0].fromId).toBe(ids.parentB);
    expect(await factsHash()).toBe(originalHash);
  });
});
