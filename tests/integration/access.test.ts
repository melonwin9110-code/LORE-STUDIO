import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Character, LoreEvent, Project, Relation, User, World, WorldData } from "../../src/lib/types";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3001";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)))) {
  throw new Error("Role fixtures may run only in a dedicated database ending in _test");
}
const database = new pg.Pool({ connectionString: databaseUrl });
class Client {
  cookie = "";
  async call<T = { error: string }>(method: string, path: string, data?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { Origin: new URL(base).origin, Cookie: this.cookie, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.headers.getSetCookie().length) this.cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    return { status: response.status, data: await response.json() as T };
  }
}

describe("server-enforced project roles and database consistency", () => {
  const owner = new Client(), member = new Client();
  let memberId: string, project: Project, world: World, first: Character, second: Character;
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const [client, name] of [[owner, "owner"], [member, "member"]] as const) {
      const result = await client.call<{ user: User }>("POST", "/auth/register", { name, email: `${name}-roles-${suffix}@example.test`, password: "Test-password-for-roles!" });
      expect(result.status).toBe(201);
      if (client === member) memberId = result.data.user.id;
    }
    const result = await owner.call<{ project: Project }>("POST", "/projects", { name: "Проверка ролей" });
    expect(result.status).toBe(201); project = result.data.project;
    const createdWorld = await owner.call<{ world: World }>("POST", `/projects/${project.id}/worlds`, { name: "Общий мир" });
    expect(createdWorld.status).toBe(201); world = createdWorld.data.world;
    for (const name of ["Лиора", "Аэрен"]) {
      const result = await owner.call<{ character: Character }>("POST", `/worlds/${world.id}/characters`, { name });
      expect(result.status).toBe(201);
      if (name === "Лиора") first = result.data.character; else second = result.data.character;
    }
    // Invitations are a later stage. A DB fixture exercises existing role checks,
    // using only the explicitly separate test database; never the app's .env DB.
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, memberId]);
  });
  afterAll(async () => {
    if (project) await owner.call("DELETE", `/projects/${project.id}`);
    await owner.call("POST", "/auth/logout");
    await member.call("POST", "/auth/logout");
    await database.end();
  });
  it("allows a reader to read but rejects every class of write", async () => {
    expect((await member.call("GET", `/worlds/${world.id}`)).status).toBe(200);
    for (const [method, path, input] of [
      ["PATCH", `/projects/${project.id}`, { name: "Forbidden" }],
      ["POST", `/projects/${project.id}/worlds`, { name: "Forbidden" }],
      ["PATCH", `/worlds/${world.id}`, { name: "Forbidden" }],
      ["POST", `/worlds/${world.id}/characters`, { name: "Forbidden" }],
      ["PATCH", `/characters/${first.id}`, { biography: "Forbidden", version: first.version }],
      ["DELETE", `/characters/${first.id}`, undefined],
      ["DELETE", `/worlds/${world.id}`, undefined],
      ["DELETE", `/projects/${project.id}`, undefined],
    ] as const) expect((await member.call(method, path, input)).status).toBe(403);
  });
  it("allows editor writes, preserves owner-only project deletion and records audit", async () => {
    await database.query("UPDATE project_members SET role='editor' WHERE project_id=$1 AND user_id=$2", [project.id, memberId]);
    const changed = await member.call<{ character: Character }>("PATCH", `/characters/${first.id}`, { biography: "Сохранено редактором", version: first.version });
    expect(changed.status).toBe(200); first = changed.data.character;
    expect((await member.call("DELETE", `/projects/${project.id}`)).status).toBe(403);
    const audit = await database.query("SELECT snapshot FROM audit_log WHERE project_id=$1 AND actor_id=$2 AND entity_id=$3 AND action='update'", [project.id, memberId, first.id]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].snapshot.after.biography).toBe("Сохранено редактором");
    expect(audit.rows[0].snapshot.before.biography).toBe("");
  });
  it("accepts one simultaneous update and rejects the stale competing update", async () => {
    const results = await Promise.all(["Первая правка", "Вторая правка"].map((biography) => owner.call<{ character: Character }>("PATCH", `/characters/${first.id}`, { biography, version: first.version })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    first = results.find((result) => result.status === 200)!.data.character;
    const saved = await owner.call<WorldData>("GET", `/worlds/${world.id}`);
    expect(saved.data.characters.find((character) => character.id === first.id)?.biography).toBe(first.biography);
  });
  it("deletes dependent links without deleting the other character or historical event", async () => {
    const event = await owner.call<{ event: LoreEvent }>("POST", `/worlds/${world.id}/events`, { name: "Встреча", startYear: 100, characterIds: [first.id, second.id] });
    expect(event.status).toBe(201);
    const relation = await owner.call<{ relation: Relation }>("POST", `/worlds/${world.id}/relations`, { fromId: first.id, toId: second.id, kind: "Дружба" });
    expect(relation.status).toBe(201);
    expect((await owner.call("DELETE", `/characters/${first.id}`)).status).toBe(200);
    const state = await owner.call<WorldData>("GET", `/worlds/${world.id}`);
    expect(state.data.characters.map((character) => character.id)).toEqual([second.id]);
    expect(state.data.relations).toHaveLength(0);
    expect(state.data.events.find((item) => item.id === event.data.event.id)?.characterIds).toEqual([second.id]);
  });
});
