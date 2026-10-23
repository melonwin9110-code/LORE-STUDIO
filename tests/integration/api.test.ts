import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Character, LoreEvent, Project, Relation, User, World, WorldData } from "../../src/lib/types";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3001";
const origin = new URL(base).origin;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Lore-test-password-2026!";

class ApiClient {
  cookie = "";

  async request<T = { error?: string }>(method: string, path: string, data?: unknown, customOrigin = origin) {
    const headers: Record<string, string> = { Origin: customOrigin };
    if (this.cookie) headers.Cookie = this.cookie;
    if (data !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: "manual",
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as T;
    return { response, body };
  }
}

describe("PostgreSQL-backed application API", () => {
  const owner = new ApiClient();
  const stranger = new ApiClient();
  const anonymous = new ApiClient();
  const projectsToClean: Array<{ client: ApiClient; id: string }> = [];
  let ownerUser: User;
  let project: Project;
  let world: World;
  let privateWorld: World;
  let privateCharacter: Character;
  let character: Character;
  let secondCharacter: Character;
  let event: LoreEvent;
  let relation: Relation;

  beforeAll(async () => {
    for (const [client, name] of [[owner, "owner"], [stranger, "stranger"]] as const) {
      const result = await client.request<{ user: User }>("POST", "/auth/register", {
        name: `Тест ${name}`, email: `${name}-${suffix}@example.test`, password,
      });
      expect(result.response.status).toBe(201);
      expect(client.cookie).toBeTruthy();
      expect(result.response.headers.get("set-cookie")).toMatch(/httponly/i);
      expect(result.response.headers.get("set-cookie")).toMatch(/samesite=lax/i);
      if (client === owner) ownerUser = result.body.user;
    }
    const ownProject = await owner.request<{ project: Project }>("POST", "/projects", {
      name: "Тестовая Элирия", description: "Интеграционные проверки",
    });
    expect(ownProject.response.status).toBe(201);
    project = ownProject.body.project;
    projectsToClean.push({ client: owner, id: project.id });
    const ownWorld = await owner.request<{ world: World }>("POST", `/projects/${project.id}/worlds`, { name: "Элирия" });
    expect(ownWorld.response.status).toBe(201);
    world = ownWorld.body.world;

    const foreignProject = await stranger.request<{ project: Project }>("POST", "/projects", { name: "Приватный мир" });
    expect(foreignProject.response.status).toBe(201);
    projectsToClean.push({ client: stranger, id: foreignProject.body.project.id });
    const foreignWorld = await stranger.request<{ world: World }>("POST", `/projects/${foreignProject.body.project.id}/worlds`, { name: "Чужой мир" });
    expect(foreignWorld.response.status).toBe(201);
    privateWorld = foreignWorld.body.world;
    const foreignCharacter = await stranger.request<{ character: Character }>("POST", `/worlds/${privateWorld.id}/characters`, { name: "Тайный персонаж", biography: "Секретная биография" });
    expect(foreignCharacter.response.status).toBe(201);
    privateCharacter = foreignCharacter.body.character;
  }, 60_000);

  afterAll(async () => {
    for (const item of projectsToClean.reverse()) await item.client.request("DELETE", `/projects/${item.id}`);
    await owner.request("POST", "/auth/logout");
    await stranger.request("POST", "/auth/logout");
  });

  it("connects to PostgreSQL and returns authenticated session without password data", async () => {
    const health = await anonymous.request("GET", "/health");
    expect(health.response.ok).toBe(true);
    const session = await owner.request<{ user: User }>("GET", "/session");
    expect(session.response.status).toBe(200);
    expect(session.body.user).toEqual(ownerUser);
    expect(JSON.stringify(session.body)).not.toMatch(/password|scrypt|session_hash/i);
  });

  it("creates an idempotent private demo with linked characters and events", async () => {
    const created = await owner.request<{ project: Project }>("POST", "/projects/demo");
    expect(created.response.ok).toBe(true);
    projectsToClean.push({ client: owner, id: created.body.project.id });
    const repeated = await owner.request<{ project: Project }>("POST", "/projects/demo");
    expect(repeated.response.ok).toBe(true);
    expect(repeated.body.project.id).toBe(created.body.project.id);
    const worlds = await owner.request<{ worlds: World[] }>("GET", `/projects/${created.body.project.id}/worlds`);
    expect(worlds.body.worlds.length).toBeGreaterThan(0);
    const demo = await owner.request<WorldData>("GET", `/worlds/${worlds.body.worlds[0].id}`);
    expect(demo.body.characters.length).toBeGreaterThanOrEqual(2);
    expect(demo.body.events.length).toBeGreaterThan(0);
    expect(demo.body.relations.length).toBeGreaterThan(0);
    expect((await stranger.request("GET", `/worlds/${worlds.body.worlds[0].id}`)).response.status).toBe(404);
  });

  it("rejects unauthenticated access and duplicate registrations", async () => {
    expect((await anonymous.request("GET", "/projects")).response.status).toBe(401);
    expect((await anonymous.request("GET", `/worlds/${world.id}`)).response.status).toBe(401);
    const duplicate = await anonymous.request("POST", "/auth/register", { name: "Дубликат", email: ownerUser.email, password });
    expect(duplicate.response.status).toBe(409);
    const wrongPassword = await anonymous.request("POST", "/auth/login", { email: ownerUser.email, password: "Incorrect-long-password!" });
    expect(wrongPassword.response.status).toBe(401);
  });

  it("keeps project lists private and denies cross-user reads and writes", async () => {
    const list = await stranger.request<{ projects: Project[] }>("GET", "/projects");
    expect(list.body.projects.some((item) => item.id === project.id)).toBe(false);
    for (const [method, path, data] of [
      ["GET", `/projects/${project.id}/worlds`, undefined],
      ["GET", `/worlds/${world.id}`, undefined],
      ["PATCH", `/projects/${project.id}`, { name: "Взлом" }],
      ["DELETE", `/projects/${project.id}`, undefined],
      ["POST", `/worlds/${world.id}/characters`, { name: "Чужая запись" }],
    ] as const) {
      expect((await stranger.request(method, path, data)).response.status).toBe(404);
    }
  });

  it("rejects cross-origin changes and invalid historic date ranges", async () => {
    expect((await owner.request("POST", "/projects", { name: "CSRF" }, "https://untrusted.example")).response.status).toBe(403);
    const invalidCharacter = await owner.request("POST", `/worlds/${world.id}/characters`, { name: "Неверная дата", birthYear: 100, deathYear: 99 });
    expect(invalidCharacter.response.status).toBe(400);
    const invalidEvent = await owner.request("POST", `/worlds/${world.id}/events`, { name: "Неверная эпоха", startYear: 100, endYear: 99 });
    expect(invalidEvent.response.status).toBe(400);
    expect((await owner.request("POST", `/worlds/${world.id}/events`, { name: "Некорректный год", startYear: 0.5 })).response.status).toBe(400);
  });

  it("creates characters with persisted text and allows optimistic updates", async () => {
    const first = await owner.request<{ character: Character }>("POST", `/worlds/${world.id}/characters`, {
      name: "Аэлин", title: "Хранительница", species: "Человек", birthYear: -120,
      biography: "Первая биография", status: "canon",
    });
    expect(first.response.status).toBe(201);
    character = first.body.character;
    const second = await owner.request<{ character: Character }>("POST", `/worlds/${world.id}/characters`, { name: "Тарен", biography: "Союзник" });
    expect(second.response.status).toBe(201);
    secondCharacter = second.body.character;
    const changed = await owner.request<{ character: Character }>("PATCH", `/characters/${character.id}`, {
      biography: "Обновлённая биография после события", version: character.version,
    });
    expect(changed.response.status).toBe(200);
    expect(changed.body.character.version).toBe(character.version + 1);
    expect(changed.body.character.name).toBe("Аэлин");
    const stale = await owner.request("PATCH", `/characters/${character.id}`, { biography: "Потерянная правка", version: character.version });
    expect(stale.response.status).toBe(409);
    character = changed.body.character;
    const persisted = await owner.request<WorldData>("GET", `/worlds/${world.id}`);
    expect(persisted.body.characters.find((item) => item.id === character.id)?.biography).toBe("Обновлённая биография после события");
  });

  it("creates and updates a historical event linked to actual characters", async () => {
    const created = await owner.request<{ event: LoreEvent }>("POST", `/worlds/${world.id}/events`, {
      name: "Союз у Белой башни", type: "Договор", startYear: -80,
      description: "Первый союз", characterIds: [character.id, secondCharacter.id], status: "canon",
    });
    expect(created.response.status).toBe(201);
    event = created.body.event;
    expect(new Set(event.characterIds)).toEqual(new Set([character.id, secondCharacter.id]));
    const changed = await owner.request<{ event: LoreEvent }>("PATCH", `/events/${event.id}`, { description: "Исправленный договор", version: event.version });
    expect(changed.response.status).toBe(200);
    expect(changed.body.event.description).toBe("Исправленный договор");
    expect((await owner.request("PATCH", `/events/${event.id}`, { name: "Устаревшая правка", version: event.version })).response.status).toBe(409);
    event = changed.body.event;
  });

  it("creates and updates a relationship between shared character IDs", async () => {
    const created = await owner.request<{ relation: Relation }>("POST", `/worlds/${world.id}/relations`, {
      fromId: character.id, toId: secondCharacter.id, kind: "Дружба", mutual: true, startYear: -80,
    });
    expect(created.response.status).toBe(201);
    relation = created.body.relation;
    const changed = await owner.request<{ relation: Relation }>("PATCH", `/relations/${relation.id}`, {
      description: "Проверенный временем союз", version: relation.version,
    });
    expect(changed.response.status).toBe(200);
    expect(changed.body.relation.description).toBe("Проверенный временем союз");
    expect((await owner.request("PATCH", `/relations/${relation.id}`, { kind: "Устаревшая правка", version: relation.version })).response.status).toBe(409);
    relation = changed.body.relation;
  });

  it("prevents linking foreign characters, self-relationships, and editing private entities", async () => {
    expect((await owner.request("POST", `/worlds/${world.id}/events`, { name: "Кража ссылки", startYear: 100, characterIds: [privateCharacter.id] })).response.status).toBe(400);
    expect((await owner.request("POST", `/worlds/${world.id}/relations`, { fromId: character.id, toId: privateCharacter.id, kind: "Враг" })).response.status).toBe(400);
    expect((await owner.request("POST", `/worlds/${world.id}/relations`, { fromId: character.id, toId: character.id, kind: "Сам себе друг" })).response.status).toBe(400);
    for (const [path, version] of [[`/characters/${character.id}`, character.version], [`/events/${event.id}`, event.version], [`/relations/${relation.id}`, relation.version]] as const) {
      const update = path.startsWith("/characters/") ? { biography: "Чужая правка", version } : { description: "Чужая правка", version };
      expect((await stranger.request("PATCH", path, update)).response.status).toBe(404);
      expect((await stranger.request("DELETE", path)).response.status).toBe(404);
    }
  });

  it("loads the same data in a new login session and revokes logout sessions", async () => {
    const fresh = new ApiClient();
    const login = await fresh.request<{ user: User }>("POST", "/auth/login", { email: ownerUser.email, password });
    expect(login.response.status).toBe(200);
    expect(login.body.user.id).toBe(ownerUser.id);
    const snapshot = await fresh.request<WorldData>("GET", `/worlds/${world.id}`);
    expect(snapshot.body.characters.find((item) => item.id === character.id)?.biography).toBe("Обновлённая биография после события");
    expect(snapshot.body.events.find((item) => item.id === event.id)?.characterIds).toEqual(expect.arrayContaining([character.id, secondCharacter.id]));
    expect(snapshot.body.relations.find((item) => item.id === relation.id)?.kind).toBe("Дружба");
    const originalCookie = fresh.cookie;
    expect((await fresh.request("POST", "/auth/logout")).response.ok).toBe(true);
    fresh.cookie = originalCookie;
    expect((await fresh.request("GET", "/projects")).response.status).toBe(401);
  });

  it("updates project/world settings and deletes entities without losing unrelated data", async () => {
    expect((await owner.request("PATCH", `/projects/${project.id}`, { name: "Новая Элирия", description: "Сохранённое описание" })).response.ok).toBe(true);
    expect((await owner.request("PATCH", `/worlds/${world.id}`, { name: "Элирия после правки" })).response.ok).toBe(true);
    expect((await owner.request("DELETE", `/relations/${relation.id}`)).response.ok).toBe(true);
    expect((await owner.request("DELETE", `/events/${event.id}`)).response.ok).toBe(true);
    expect((await owner.request("DELETE", `/characters/${character.id}`)).response.ok).toBe(true);
    const snapshot = await owner.request<WorldData>("GET", `/worlds/${world.id}`);
    expect(snapshot.body.world.name).toBe("Элирия после правки");
    expect(snapshot.body.characters.some((item) => item.id === character.id)).toBe(false);
    expect(snapshot.body.characters.some((item) => item.id === secondCharacter.id)).toBe(true);
    expect(snapshot.body.events).toHaveLength(0);
    expect(snapshot.body.relations).toHaveLength(0);
    const ownProjects = await owner.request<{ projects: Project[] }>("GET", "/projects");
    expect(ownProjects.body.projects.find((item) => item.id === project.id)?.name).toBe("Новая Элирия");
  });
});
