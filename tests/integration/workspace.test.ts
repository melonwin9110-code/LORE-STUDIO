import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import type { Character, Project, Relation, User, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { CatalogResult, FamilyData, TimelineGraph } from "../../src/lib/workspace-types";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
const origin = new URL(base).origin;
const databaseURL = process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(new URL(databaseURL).pathname.slice(1)))) throw new Error("Workspace fixtures require a dedicated *_test database");
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
    if (cookies.length) this.cookie = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
    const data = await response.json() as T;
    return { status: response.status, data };
  }
  raw(method: string, path: string, bytes?: Buffer, contentType = "image/png") {
    return fetch(`${base}/api${path}`, {
      method, headers: { Origin: origin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(bytes ? { "Content-Type": contentType } : {}) },
      body: bytes ? new Uint8Array(bytes) : undefined,
    });
  }
}
const scope = (timeline: string, day?: string) => `?${new URLSearchParams({ timeline, ...(day === undefined ? {} : { day }) })}`;

describe("workspace 0.3: groups, independent family, portraits, catalog and timeline editor", () => {
  const owner = new Client(), stranger = new Client(), anonymous = new Client();
  let project: Project, foreignProject: Project, memberId: string;
  let world: World, main: Timeline, foreignWorld: World, foreignMain: Timeline, foreignCharacter: Character;
  let png: Buffer, secondPng: Buffer;

  async function newWorld(name: string, targetProject = project.id) {
    const result = await owner.call<{ world: World }>("POST", `/projects/${targetProject}/worlds`, { name });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    const loaded = await owner.call<WorldData>("GET", `/worlds/${result.data.world.id}`);
    expect(loaded.status).toBe(200);
    return { world: result.data.world, main: loaded.data.history!.timeline };
  }
  async function character(name: string, extra: Record<string, unknown> = {}, worldId = world.id, timeline = main.id) {
    const result = await owner.call<{ character: Character }>("POST", `/worlds/${worldId}/characters${scope(timeline, "10")}`, { name, ...extra });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data.character;
  }
  async function state(timeline = main.id, day?: string) {
    const result = await owner.call<WorldData>("GET", `/worlds/${world.id}${scope(timeline, day)}`);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data;
  }
  async function fork(day = "15") {
    const parent = (await state()).history!.timeline;
    const result = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: `Ветвь ${randomUUID().slice(0, 6)}`, parentId: main.id, forkDay: day, expectedParentRevision: parent.headRevision });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data.timeline;
  }
  async function independent() {
    const result = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: "Независимая линия" });
    expect(result.status).toBe(201);
    return result.data.timeline;
  }
  async function family() {
    const result = await owner.call<FamilyData>("GET", `/worlds/${world.id}/family`);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data;
  }
  async function familyEdge(fromId: string, toId: string, current: FamilyData, familyKind = "parent") {
    return owner.call<FamilyData>("POST", `/worlds/${world.id}/family/relations`, { fromId, toId, familyKind, description: "Проверяемая семейная связь", expectedVersion: current.version });
  }
  async function group(ids: string[], extra: Record<string, unknown> = {}) {
    return owner.call<{ relation: Relation }>("POST", `/worlds/${world.id}/relations${scope(main.id, "10")}`, { participantIds: ids, kind: "Союз", ...extra });
  }
  async function graph() {
    const result = await owner.call<TimelineGraph>("GET", `/worlds/${world.id}/timeline-graph`);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data;
  }
  beforeAll(async () => {
    png = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 145, g: 88, b: 205 } } }).png().toBuffer();
    secondPng = await sharp({ create: { width: 24, height: 32, channels: 3, background: { r: 25, g: 155, b: 92 } } }).png().toBuffer();
    for (const [client, name] of [[owner, "owner"], [stranger, "stranger"]] as const) {
      const result = await client.call<{ user: User }>("POST", "/auth/register", { name, email: `workspace-${name}-${suffix}@example.test`, password: "Workspace-test-password-2026!" });
      expect(result.status).toBe(201);
      if (client === stranger) memberId = result.data.user.id;
    }
    const own = await owner.call<{ project: Project }>("POST", "/projects", { name: `Общая мастерская ${suffix}` });
    expect(own.status).toBe(201); project = own.data.project;
    const other = await stranger.call<{ project: Project }>("POST", "/projects", { name: `Чужой приватный проект ${suffix}` });
    expect(other.status).toBe(201); foreignProject = other.data.project;
    const created = await stranger.call<{ world: World }>("POST", `/projects/${foreignProject.id}/worlds`, { name: "Закрытый чужой мир" });
    expect(created.status).toBe(201); foreignWorld = created.data.world;
    foreignMain = (await stranger.call<WorldData>("GET", `/worlds/${foreignWorld.id}`)).data.history!.timeline;
    const foreign = await stranger.call<{ character: Character }>("POST", `/worlds/${foreignWorld.id}/characters`, { name: `Чужой герой ${suffix}` });
    expect(foreign.status).toBe(201); foreignCharacter = foreign.data.character;
  }, 60000);
  beforeEach(async () => { const created = await newWorld("Мир отдельной проверки 0.3"); world = created.world; main = created.main; });
  afterAll(async () => {
    if (project) await owner.call("DELETE", `/projects/${project.id}`);
    if (foreignProject) await stranger.call("DELETE", `/projects/${foreignProject.id}`);
    await owner.call("POST", "/auth/logout"); await stranger.call("POST", "/auth/logout");
    await database.end();
  });

  it("keeps legacy pairs and accepts one group with exactly two or ten participants", async () => {
    const people: Character[] = [];
    for (let index = 0; index < 10; index++) people.push(await character(`Участник ${index}`));
    const pair = await owner.call<{ relation: Relation }>("POST", `/worlds/${world.id}/relations${scope(main.id, "10")}`, { fromId: people[0].id, toId: people[1].id, kind: "Дружба" });
    expect(pair.status).toBe(201);
    expect(pair.data.relation.participantIds).toEqual([people[0].id, people[1].id]);
    const two = await group(people.slice(0, 2).map((person) => person.id));
    expect(two.status).toBe(201);
    const ten = await group(people.map((person) => person.id));
    expect(ten.status, JSON.stringify(ten.data)).toBe(201);
    expect(ten.data.relation.participantIds).toEqual(people.map((person) => person.id));
    const loaded = await state();
    expect(loaded.relations).toHaveLength(3);
    expect(loaded.relations.find((relation) => relation.id === ten.data.relation.id)?.participantIds).toHaveLength(10);
  });

  it("rejects participant counts, duplicates and cross-world IDs without partial relation writes", async () => {
    const people: Character[] = [];
    for (let index = 0; index < 11; index++) people.push(await character(`Проверка количества ${index}`));
    const foreign = await newWorld("Другой мир этого владельца");
    const outside = await character("Персонаж другого мира", {}, foreign.world.id, foreign.main.id);
    for (const ids of [[people[0].id], people.map((person) => person.id), [people[0].id, people[0].id], [people[0].id, outside.id], [people[0].id, foreignCharacter.id]]) {
      expect((await group(ids)).status).toBe(400);
    }
    expect((await group([people[0].id, people[1].id], { fromId: people[1].id, toId: people[0].id })).status).toBe(400);
    expect((await group([people[0].id, people[1].id, people[2].id], { familyKind: "parent" })).status).toBe(400);
    expect((await state()).relations).toHaveLength(0);
  });

  it("checks all group references on edits and preserves previous valid participants", async () => {
    const first = await character("Первый"), second = await character("Второй"), third = await character("Третий");
    const created = await group([first.id, second.id, third.id]);
    expect(created.status).toBe(201);
    const relation = created.data.relation;
    const rejected = await owner.call("PATCH", `/relations/${relation.id}${scope(main.id, "20")}`, { participantIds: [first.id, second.id, foreignCharacter.id], version: relation.version });
    expect(rejected.status).toBe(400);
    expect((await state()).relations[0].participantIds).toEqual([first.id, second.id, third.id]);
    const changed = await owner.call<{ relation: Relation }>("PATCH", `/relations/${relation.id}${scope(main.id, "20")}`, { participantIds: [first.id, second.id], version: relation.version });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    expect((await state(main.id, "19")).relations[0].participantIds).toHaveLength(3);
    expect((await state(main.id, "20")).relations[0].participantIds).toEqual([first.id, second.id]);
  });

  it("removes a deleted member from a group while preserving past dates and other branches", async () => {
    const first = await character("Удаляемый участник"), second = await character("Второй участник"), third = await character("Третий участник");
    const created = await group([first.id, second.id, third.id]);
    expect(created.status).toBe(201);
    const branch = await fork();
    expect((await owner.call("DELETE", `/characters/${first.id}${scope(main.id, "20")}`)).status).toBe(200);
    const current = (await state(main.id, "20")).relations[0];
    expect(current.id).toBe(created.data.relation.id);
    expect(current.participantIds).toEqual([second.id, third.id]);
    expect(current.fromId).toBe(second.id); expect(current.toId).toBe(third.id);
    expect((await state(main.id, "19")).relations[0].participantIds).toHaveLength(3);
    expect((await state(branch.id, "30")).relations[0].participantIds).toHaveLength(3);
    expect((await owner.call("DELETE", `/characters/${second.id}${scope(main.id, "21")}`)).status).toBe(200);
    expect((await state(main.id, "21")).relations).toHaveLength(0);
    expect((await state(branch.id, "30")).relations[0].participantIds).toHaveLength(3);
  });

  it("transfers a group and every linked participant atomically using the same stable IDs", async () => {
    const people = [await character("Перенос один"), await character("Перенос два"), await character("Перенос три")];
    const created = await group(people.map((person) => person.id));
    expect(created.status).toBe(201);
    const target = await independent();
    const transfer = (includeDependencies: boolean) => owner.call<{ transferred: number }>("POST", `/timelines/${target.id}/transfer`, { sourceId: main.id, sourceDay: "10", targetDay: "10", objectIds: [created.data.relation.id], expectedRevision: target.headRevision, includeDependencies });
    expect((await transfer(false)).status).toBe(400);
    expect((await state(target.id)).characters).toHaveLength(0);
    const copied = await transfer(true);
    expect(copied.status, JSON.stringify(copied.data)).toBe(200); expect(copied.data.transferred).toBe(4);
    expect((await state(target.id)).relations[0]).toMatchObject({ id: created.data.relation.id, participantIds: people.map((person) => person.id) });
    expect((await state(target.id)).characters.map((person) => person.id).sort()).toEqual(people.map((person) => person.id).sort());
    expect((await state()).relations[0].participantIds).toHaveLength(3);
  });

  it("opens and edits one independent family without a date and keeps it across timeline changes", async () => {
    const parent = await character("Глобальный родитель", { birthYear: 0 }), child = await character("Первый ребёнок", { birthYear: 20 }), sibling = await character("Второй ребёнок", { birthYear: 25 });
    const branch = await fork();
    let current = await family();
    expect(current.migration?.required ?? false).toBe(false);
    expect(current.characters.map((person) => person.id).sort()).toEqual([parent.id, child.id, sibling.id].sort());
    const first = await familyEdge(parent.id, child.id, current);
    expect(first.status, JSON.stringify(first.data)).toBe(201); current = first.data;
    const second = await familyEdge(parent.id, sibling.id, current);
    expect(second.status, JSON.stringify(second.data)).toBe(201); current = second.data;
    const readThroughBranch = await owner.call<FamilyData>("GET", `/worlds/${world.id}/family${scope(branch.id, "100")}`);
    expect(readThroughBranch.status).toBe(200);
    expect(readThroughBranch.data.relations).toEqual(current.relations);
    expect(readThroughBranch.data.version).toBe(current.version);
    expect((await state(main.id)).relations).toHaveLength(0);
    expect((await state(branch.id)).relations).toHaveLength(0);
    expect((await family()).relations).toHaveLength(2);
  });

  it("rejects family cycles, biological contradictions and stale aggregate or edge edits", async () => {
    const parent = await character("Предок", { birthYear: 0 }), child = await character("Потомок", { birthYear: 20 }), grandchild = await character("Следующее поколение", { birthYear: 40 });
    const initial = await family();
    const first = await familyEdge(parent.id, child.id, initial); expect(first.status).toBe(201);
    expect((await familyEdge(parent.id, grandchild.id, initial)).status).toBe(409);
    const second = await familyEdge(child.id, grandchild.id, first.data); expect(second.status).toBe(201);
    expect((await familyEdge(grandchild.id, parent.id, second.data)).status).toBe(400);
    const young = await character("Молодой родитель", { birthYear: 50 });
    expect((await familyEdge(young.id, child.id, await family())).status).toBe(400);
    const foreign = await newWorld("Чужой семье мир");
    const outside = await character("Внешний родственник", {}, foreign.world.id, foreign.main.id);
    expect((await familyEdge(parent.id, outside.id, await family())).status).toBe(400);
    const before = await family();
    const edge = before.relations.find((relation) => relation.fromId === parent.id)!;
    const patched = await owner.call<FamilyData>("PATCH", `/family/relations/${edge.id}`, { description: "Обновлённое описание", version: edge.version, expectedVersion: before.version });
    expect(patched.status, JSON.stringify(patched.data)).toBe(200);
    expect(patched.data.relations.find((relation) => relation.id === edge.id)?.description).toBe("Обновлённое описание");
    expect((await owner.call("PATCH", `/family/relations/${edge.id}`, { description: "Устаревшая правка", version: edge.version, expectedVersion: patched.data.version })).status).toBe(409);
    expect((await owner.call("DELETE", `/family/relations/${edge.id}`, { expectedVersion: before.version })).status).toBe(409);
    const removed = await owner.call<FamilyData>("DELETE", `/family/relations/${edge.id}`, { expectedVersion: patched.data.version });
    expect(removed.status).toBe(200);
    expect(removed.data.relations.some((relation) => relation.id === edge.id)).toBe(false);
  });

  it("keeps branch-only character identities available to the independent family", async () => {
    const parent = await character("Родитель основы", { birthYear: 0 });
    const branch = await independent();
    const child = await character("Ребёнок только другой линии", { birthYear: 20 }, world.id, branch.id);
    const current = await family();
    expect(current.characters.some((person) => person.id === child.id && person.sourceTimelineId === branch.id)).toBe(true);
    const linked = await familyEdge(parent.id, child.id, current);
    expect(linked.status, JSON.stringify(linked.data)).toBe(201);
    expect(linked.data.relations).toHaveLength(1);
  });

  it("stores a decoded portrait, exposes it on lists and replaces or removes it with access checks", async () => {
    const first = await character(`Портрет ${suffix}`);
    const branch = await fork();
    const uploaded = await owner.raw("PUT", `/characters/${first.id}/portrait`, png);
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const firstUrl = (await uploaded.json() as { portraitUrl: string }).portraitUrl;
    expect(firstUrl).toContain(`/characters/${first.id}/portrait`);
    const fetched = await owner.raw("GET", `/characters/${first.id}/portrait`);
    expect(fetched.status).toBe(200); expect(fetched.headers.get("content-type")).toContain("image/webp");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetched.headers.get("cache-control")).toMatch(/private|no-store/);
    const metadata = await sharp(Buffer.from(await fetched.arrayBuffer())).metadata();
    expect(metadata.format).toBe("webp"); expect(metadata.width).toBe(32); expect(metadata.height).toBe(24);
    expect((await state()).characters.find((person) => person.id === first.id)?.portraitUrl).toBe(firstUrl);
    expect((await state(branch.id)).characters.find((person) => person.id === first.id)?.portraitUrl).toBe(firstUrl);
    const catalog = await owner.call<CatalogResult>("GET", `/characters/catalog?q=${encodeURIComponent(`Портрет ${suffix}`)}`);
    expect(catalog.status).toBe(200);
    expect(catalog.data.characters.every((entry) => entry.character.portraitUrl === firstUrl)).toBe(true);
    const replaced = await owner.raw("PUT", `/characters/${first.id}/portrait`, secondPng);
    expect(replaced.status).toBe(200);
    const secondUrl = (await replaced.json() as { portraitUrl: string }).portraitUrl;
    expect(secondUrl).not.toBe(firstUrl);
    const replacement = await owner.raw("GET", `/characters/${first.id}/portrait`);
    expect((await sharp(Buffer.from(await replacement.arrayBuffer())).metadata()).width).toBe(24);
    expect((await anonymous.raw("GET", `/characters/${first.id}/portrait`)).status).toBe(401);
    expect((await stranger.raw("GET", `/characters/${first.id}/portrait`)).status).toBe(404);
    expect((await stranger.raw("PUT", `/characters/${first.id}/portrait`, png)).status).toBe(404);
    expect((await owner.raw("DELETE", `/characters/${first.id}/portrait`)).status).toBe(200);
    expect((await owner.raw("GET", `/characters/${first.id}/portrait`)).status).toBe(404);
    expect((await state()).characters.find((person) => person.id === first.id)?.portraitUrl ?? null).toBeNull();
  });

  it("rejects SVG, HTML, corrupt images and oversized uploads without overwriting a valid portrait", async () => {
    const first = await character("Защищённый портрет");
    expect((await owner.raw("PUT", `/characters/${first.id}/portrait`, png)).status).toBe(200);
    const before = await (await owner.raw("GET", `/characters/${first.id}/portrait`)).arrayBuffer();
    expect((await owner.raw("PUT", `/characters/${first.id}/portrait`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml")).status).toBe(415);
    expect((await owner.raw("PUT", `/characters/${first.id}/portrait`, Buffer.from("<html>bad</html>"), "text/html")).status).toBe(415);
    expect((await owner.raw("PUT", `/characters/${first.id}/portrait`, Buffer.from("not-a-png"))).status).toBe(400);
    expect((await owner.raw("PUT", `/characters/${first.id}/portrait`, Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(413);
    const after = await (await owner.raw("GET", `/characters/${first.id}/portrait`)).arrayBuffer();
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });

  it("lists labelled character variants across accessible sources with search, filters and pagination", async () => {
    const prefix = `Каталог-${suffix}-${randomUUID().slice(0, 6)}`;
    const first = await character(`${prefix} Основной`);
    const branch = await fork();
    const changed = await owner.call<{ character: Character }>("PATCH", `/characters/${first.id}${scope(branch.id, "20")}`, { name: `${prefix} Вариант`, version: first.version });
    expect(changed.status).toBe(200);
    const other = await newWorld("Второй источник каталога");
    const second = await character(`${prefix} Другой мир`, {}, other.world.id, other.main.id);
    const firstPage = await owner.call<CatalogResult>("GET", `/characters/catalog?q=${encodeURIComponent(prefix)}&limit=1`);
    expect(firstPage.status, JSON.stringify(firstPage.data)).toBe(200);
    expect(firstPage.data.total).toBe(3); expect(firstPage.data.characters).toHaveLength(1); expect(firstPage.data.nextCursor).not.toBeNull();
    const entries = [...firstPage.data.characters];
    let cursor = firstPage.data.nextCursor;
    for (let page = 0; cursor !== null && page < 5; page++) {
      const next = await owner.call<CatalogResult>("GET", `/characters/catalog?q=${encodeURIComponent(prefix)}&limit=1&cursor=${cursor}`);
      expect(next.status).toBe(200); entries.push(...next.data.characters); cursor = next.data.nextCursor;
    }
    expect(cursor).toBeNull(); expect(entries).toHaveLength(3); expect(new Set(entries.map((entry) => entry.key)).size).toBe(3);
    expect(entries.every((entry) => entry.project.id === project.id && entry.project.name === project.name)).toBe(true);
    expect(entries.find((entry) => entry.character.id === second.id)?.world.name).toBe(other.world.name);
    const forkVariant = entries.find((entry) => entry.timeline.id === branch.id)!;
    expect(forkVariant.character.id).toBe(first.id); expect(forkVariant.character.name).toContain("Вариант"); expect(forkVariant.timeline.name).toBe(branch.name);
    const filtered = await owner.call<CatalogResult>("GET", `/characters/catalog?q=${encodeURIComponent(prefix)}&world=${world.id}&timeline=${branch.id}`);
    expect(filtered.status).toBe(200); expect(filtered.data.characters).toHaveLength(1); expect(filtered.data.characters[0].key).toBe(forkVariant.key);
    const otherUser = await stranger.call<CatalogResult>("GET", `/characters/catalog?q=${encodeURIComponent(prefix)}`);
    expect(otherUser.status).toBe(200); expect(otherUser.data.characters).toHaveLength(0);
    expect((await anonymous.call("GET", "/characters/catalog")).status).toBe(401);
    expect((await owner.call("GET", "/characters/catalog?cursor=NaN")).status).toBe(400);
  });

  it("saves graph positions and manual story links without changing immutable parent snapshots", async () => {
    await character("Персонаж графа");
    const branch = await fork();
    const initial = await graph();
    const connection = { id: randomUUID(), sourceId: main.id, targetId: branch.id, kind: "intersection" as const, label: "Встреча историй" };
    const input: TimelineGraph = { version: initial.version, positions: { [main.id]: { x: 10, y: 20 }, [branch.id]: { x: 360, y: 140 } }, viewport: { x: 12, y: -8, zoom: 0.85 }, connections: [connection] };
    const saved = await owner.call<TimelineGraph>("PUT", `/worlds/${world.id}/timeline-graph`, input);
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data.version).toBeGreaterThan(initial.version);
    const loaded = await graph(); expect(loaded.positions).toEqual(input.positions); expect(loaded.viewport).toEqual(input.viewport); expect(loaded.connections).toEqual([connection]);
    expect((await owner.call("PUT", `/worlds/${world.id}/timeline-graph`, input)).status).toBe(409);
    const back = { id: randomUUID(), sourceId: branch.id, targetId: main.id, kind: "influence" as const, label: "Обратное влияние" };
    const cycle = await owner.call<TimelineGraph>("PUT", `/worlds/${world.id}/timeline-graph`, { ...loaded, connections: [connection, back] });
    expect(cycle.status).toBe(200); expect(cycle.data.connections).toHaveLength(2);
    const ancestry = (await state()).history!.timelines.find((line) => line.id === branch.id)!;
    expect(ancestry.parentId).toBe(main.id); expect(ancestry.parentRevision).toBe(branch.parentRevision); expect(ancestry.forkDay).toBe(branch.forkDay);
  });

  it("rejects invalid graph coordinates, self links and foreign-world endpoints atomically", async () => {
    const branch = await fork();
    const initial = await graph();
    const own = { id: randomUUID(), sourceId: main.id, targetId: branch.id, kind: "travel", label: "Переход" };
    for (const changed of [
      { ...initial, viewport: { x: 0, y: 0, zoom: 0 } },
      { ...initial, positions: { [main.id]: { x: Number.POSITIVE_INFINITY, y: 0 } } },
      { ...initial, positions: { [foreignMain.id]: { x: 0, y: 0 } } },
      { ...initial, connections: [{ ...own, targetId: main.id }] },
      { ...initial, connections: [{ ...own, targetId: foreignMain.id }] },
      { ...initial, connections: [own, own] },
    ]) expect((await owner.call("PUT", `/worlds/${world.id}/timeline-graph`, changed)).status).toBe(400);
    expect(await graph()).toEqual(initial);
  });

  it("enforces privacy and reader roles for all new global resources and writes", async () => {
    const first = await character("Читаемый персонаж"), second = await character("Второй читаемый персонаж");
    const initialFamily = await family(), initialGraph = await graph();
    for (const client of [anonymous, stranger]) {
      const denied = client === anonymous ? 401 : 404;
      for (const [method, path, input] of [
        ["GET", `/worlds/${world.id}/family`, undefined],
        ["POST", `/worlds/${world.id}/family/relations`, { fromId: first.id, toId: foreignCharacter.id, familyKind: "parent", expectedVersion: initialFamily.version }],
        ["POST", `/worlds/${world.id}/family/import`, { timelineId: main.id, expectedVersion: initialFamily.version }],
        ["GET", `/worlds/${world.id}/timeline-graph`, undefined],
        ["PUT", `/worlds/${world.id}/timeline-graph`, initialGraph],
      ] as const) expect((await client.call(method, path, input)).status).toBe(denied);
    }
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, memberId]);
    try {
      expect((await stranger.call("GET", `/worlds/${world.id}/family`)).status).toBe(200);
      expect((await stranger.call("GET", `/worlds/${world.id}/timeline-graph`)).status).toBe(200);
      expect((await stranger.call<CatalogResult>("GET", `/characters/catalog?world=${world.id}`)).data.characters.some((entry) => entry.character.id === first.id)).toBe(true);
      expect((await stranger.call("PUT", `/worlds/${world.id}/timeline-graph`, initialGraph)).status).toBe(403);
      expect((await stranger.call("POST", `/worlds/${world.id}/family/relations`, { fromId: first.id, toId: second.id, familyKind: "spouse", expectedVersion: initialFamily.version })).status).toBe(403);
      expect((await stranger.raw("PUT", `/characters/${first.id}/portrait`, png)).status).toBe(403);
      expect((await stranger.raw("DELETE", `/characters/${first.id}/portrait`)).status).toBe(403);
    } finally { await database.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [project.id, memberId]); }
  });
});
