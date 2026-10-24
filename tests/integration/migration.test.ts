import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

const testURL = new URL(process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test");
if (!decodeURIComponent(testURL.pathname.slice(1)).endsWith("_test")) throw new Error("Migration tests require a separate *_test database");
const adminURL = new URL(testURL);
adminURL.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminURL.toString() });
const fixtureName = `lore_upgrade_${randomUUID().replaceAll("-", "")}_test`;
const fixtureURL = new URL(testURL);
fixtureURL.pathname = `/${fixtureName}`;
const fixture = new pg.Client({ connectionString: fixtureURL.toString() });
const ids = Object.fromEntries(["user", "project", "world", "character", "event", "relation", "other"].map((key) => [key, randomUUID()]));
let created = false;

async function applyPending() {
  for (const name of (await readdir("db/migrations")).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
    if ((await fixture.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name])).rowCount) continue;
    await fixture.query("BEGIN");
    try {
      await fixture.query(await readFile(`db/migrations/${name}`, "utf8"));
      await fixture.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await fixture.query("COMMIT");
    } catch (error) { await fixture.query("ROLLBACK"); throw error; }
  }
}

describe("upgrade from real stage-1 schema without data loss", () => {
  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${fixtureName}"`);
    created = true;
    await fixture.connect();
    await fixture.query("CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await fixture.query(await readFile("db/migrations/001_initial.sql", "utf8"));
    await fixture.query("INSERT INTO schema_migrations(name) VALUES('001_initial.sql')");
    await fixture.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Старый автор','old@example.test','fixture-not-a-password')", [ids.user]);
    await fixture.query("INSERT INTO projects(id,owner_id,name) VALUES($1,$2,'Существующая вселенная')", [ids.project, ids.user]);
    await fixture.query("INSERT INTO project_members VALUES($1,$2,'owner')", [ids.project, ids.user]);
    await fixture.query("INSERT INTO worlds(id,project_id,name) VALUES($1,$2,'Мир до обновления')", [ids.world, ids.project]);
    await fixture.query("INSERT INTO characters(id,world_id,data,version) VALUES($1,$2,$3,7),($4,$2,$5,2)", [ids.character, ids.world, JSON.stringify({ name: "Лиора", biography: "Важная биография пользователя", birthYear: 900 }), ids.other, JSON.stringify({ name: "Аэрен", biography: "Другой герой", birthYear: 930 })]);
    await fixture.query("INSERT INTO events(id,world_id,data,version) VALUES($1,$2,$3,4)", [ids.event, ids.world, JSON.stringify({ name: "Старый договор", startYear: 940, characterIds: [] })]);
    await fixture.query("INSERT INTO event_participants VALUES($1,$2,$3),($1,$4,$3)", [ids.event, ids.character, ids.world, ids.other]);
    await fixture.query("INSERT INTO relations(id,world_id,from_id,to_id,data,version) VALUES($1,$2,$3,$4,$5,3)", [ids.relation, ids.world, ids.character, ids.other, JSON.stringify({ kind: "Союз", mutual: true })]);
    await applyPending();
  }, 30000);
  afterAll(async () => {
    await fixture.end();
    // Drop only the random fixture DB created above, never an existing database.
    if (created) await admin.query(`DROP DATABASE "${fixtureName}"`);
    await admin.end();
  });
  it("preserves users, identities, versions, biography and all linked object IDs", async () => {
    expect((await fixture.query("SELECT password_hash FROM users WHERE id=$1", [ids.user])).rows[0].password_hash).toBe("fixture-not-a-password");
    expect((await fixture.query("SELECT data,version FROM characters WHERE id=$1", [ids.character])).rows[0]).toMatchObject({ version: 7, data: { biography: "Важная биография пользователя" } });
    const line = (await fixture.query("SELECT id,head_revision,parent_id FROM timelines WHERE world_id=$1 AND is_main", [ids.world])).rows[0];
    expect(line.parent_id).toBeNull();
    expect(BigInt(line.head_revision)).toBeGreaterThan(0n);
    const revisions = (await fixture.query("SELECT object_id,version,data,effective_day FROM lore_revisions WHERE timeline_id=$1 ORDER BY object_id", [line.id])).rows;
    expect(revisions).toHaveLength(4);
    expect(revisions.every((row) => row.effective_day === "-1000000000000000")).toBe(true);
    expect(revisions.find((row) => row.object_id === ids.character)).toMatchObject({ version: 7, data: { biography: "Важная биография пользователя" } });
    expect(revisions.find((row) => row.object_id === ids.event)?.data.characterIds.sort()).toEqual([ids.character, ids.other].sort());
    expect(revisions.find((row) => row.object_id === ids.relation)?.data).toMatchObject({ fromId: ids.character, toId: ids.other, kind: "Союз" });
    expect((await fixture.query("SELECT id FROM world_calendars WHERE world_id=$1 AND is_default", [ids.world])).rowCount).toBe(1);
  });
  it("repeating migrations does not duplicate revisions and SQL forbids rewriting immutable facts", async () => {
    const before = (await fixture.query("SELECT count(*) FROM lore_revisions")).rows[0].count;
    await applyPending();
    expect((await fixture.query("SELECT count(*) FROM lore_revisions")).rows[0].count).toBe(before);
    await expect(fixture.query("UPDATE lore_revisions SET data='{}'::jsonb WHERE object_id=$1", [ids.character])).rejects.toThrow(/immutable/i);
    await expect(fixture.query("DELETE FROM lore_revisions WHERE object_id=$1", [ids.character])).rejects.toThrow(/immutable/i);
    expect((await fixture.query("SELECT count(*) FROM lore_revisions")).rows[0].count).toBe(before);
  });
});
