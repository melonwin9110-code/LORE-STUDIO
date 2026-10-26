import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import type { Character, LoreEvent, Project, User, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { MapData } from "../../src/lib/map-types";
import type { WikiArticleInput, WikiHistory, WikiImage, WikiIndex, WikiPage } from "../../src/lib/wiki-types";
import type { WikiDocument } from "../../src/lib/wiki-document";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
const origin = new URL(base).origin;
const databaseURL = process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!/^[A-Za-z0-9_]+_test$/.test(decodeURIComponent(new URL(databaseURL).pathname.slice(1)))) throw new Error("Wiki checks require a dedicated *_test database");
const database = new pg.Pool({ connectionString: databaseURL });
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  async image(method: "GET" | "POST", path: string, bytes?: Buffer, contentType = "image/png", requestOrigin = origin) {
    return fetch(`${base}/api${path}`, { method, headers: { Origin: requestOrigin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(bytes ? { "Content-Type": contentType } : {}) }, body: bytes ? new Uint8Array(bytes) : undefined });
  }
}
const scope = (timeline: string, day?: string, revision?: string) => `?${new URLSearchParams({ timeline, ...(day === undefined ? {} : { day }), ...(revision === undefined ? {} : { revision }) })}`;
const document = (text: string): WikiDocument => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const withLinks = (targetId: string, label = "Ссылка на известную статью"): WikiDocument => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "loreLink", attrs: { targetId, label } }] }] });
const input = (extra: Partial<WikiArticleInput> = {}): WikiArticleInput => ({ title: "Летопись Северной долины", summary: "Авторская заметка", document: document("Серебряные драконы охраняют древнюю библиотеку."), category: "История", tags: ["летопись", "драконы"], knowledge: "legend", sourceId: null, ...extra });
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

describe("wiki 0.6: authored documents, dynamic facts, pinned history and private media", () => {
  const owner = new Client(), stranger = new Client(), reader = new Client(), anonymous = new Client();
  let project: Project, otherProject: Project, readerId: string;
  let world: World, main: Timeline, foreignWorld: World, foreignMain: Timeline, foreignCharacter: Character;
  async function newWorld(name: string, client = owner, projectId = project.id) {
    const created = await client.call<{ world: World }>("POST", `/projects/${projectId}/worlds`, { name });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const state = await client.call<WorldData>("GET", `/worlds/${created.data.world.id}`);
    expect(state.status).toBe(200);
    return { world: created.data.world, main: state.data.history!.timeline };
  }
  async function character(name = "Хранитель библиотеки", day = "10", client = owner, worldId = world.id, timeline = main.id) {
    const created = await client.call<{ character: Character }>("POST", `/worlds/${worldId}/characters${scope(timeline, day)}`, { name, biography: "Структурированная биография хранителя", title: "Смотритель" });
    expect(created.status, JSON.stringify(created.data)).toBe(201); return created.data.character;
  }
  async function article(extra: Partial<WikiArticleInput> = {}, timeline = main.id, day = "10") {
    const created = await owner.call<WikiPage>("POST", `/worlds/${world.id}/wiki${scope(timeline, day)}`, input(extra));
    expect(created.status, JSON.stringify(created.data)).toBe(201); expect(created.data.article).not.toBeNull(); return created.data;
  }
  async function page(id: string, timeline = main.id, day?: string, revision?: string) {
    return owner.call<WikiPage>("GET", `/worlds/${world.id}/wiki/${id}${scope(timeline, day, revision)}`);
  }
  async function list(timeline = main.id, day?: string, filters: Record<string, string> = {}) {
    const result = await owner.call<WikiIndex>("GET", `/worlds/${world.id}/wiki${scope(timeline, day)}&${new URLSearchParams(filters)}`);
    expect(result.status, JSON.stringify(result.data)).toBe(200); return result.data;
  }
  async function fork(parentId = main.id, day = "15") {
    const current = await owner.call<WorldData>("GET", `/worlds/${world.id}${scope(parentId)}`);
    const created = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: `Ветка летописи ${randomUUID().slice(0, 6)}`, parentId, forkDay: day, expectedParentRevision: current.data.history!.timeline.headRevision });
    expect(created.status, JSON.stringify(created.data)).toBe(201); return created.data.timeline;
  }
  async function upload(client = owner, worldId = world.id, color = "#a05080") {
    const png = await sharp({ create: { width: 18, height: 12, channels: 3, background: color } }).png().toBuffer();
    const response = await client.image("POST", `/worlds/${worldId}/wiki/images`, png);
    expect(response.status, await response.clone().text()).toBe(201);
    return { image: await response.json() as WikiImage, original: png };
  }
  beforeAll(async () => {
    for (const [client, name] of [[owner, "owner"], [stranger, "stranger"], [reader, "reader"]] as const) {
      const created = await client.call<{ user: User }>("POST", "/auth/register", { name, email: `wiki-${name}-${suffix}@example.test`, password: "Wiki-integration-password-2026!" });
      expect(created.status).toBe(201); if (client === reader) readerId = created.data.user.id;
    }
    const own = await owner.call<{ project: Project }>("POST", "/projects", { name: `Энциклопедия ${suffix}` });
    expect(own.status).toBe(201); project = own.data.project;
    const other = await stranger.call<{ project: Project }>("POST", "/projects", { name: `Чужая энциклопедия ${suffix}` });
    expect(other.status).toBe(201); otherProject = other.data.project;
    const foreign = await newWorld("Закрытая чужая история", stranger, otherProject.id); foreignWorld = foreign.world; foreignMain = foreign.main;
    foreignCharacter = await character("Секрет чужого проекта", "10", stranger, foreignWorld.id, foreignMain.id);
  }, 60000);
  beforeEach(async () => {
    const fresh = await newWorld("Мир отдельной Wiki-проверки"); world = fresh.world; main = fresh.main;
  });
  afterAll(async () => {
    const removed = await Promise.all([
      ...(project ? [owner.call("DELETE", `/projects/${project.id}`)] : []),
      ...(otherProject ? [stranger.call("DELETE", `/projects/${otherProject.id}`)] : []),
    ]);
    await owner.call("POST", "/auth/logout"); await stranger.call("POST", "/auth/logout"); await reader.call("POST", "/auth/logout");
    await database.end();
    for (const result of removed) expect(result.status, JSON.stringify(result.data)).toBe(200);
  });

  it("persists rich documents and metadata as immutable historical article facts", async () => {
    const person = await character();
    const rich: WikiDocument = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Начало летописи" }] },
      { type: "paragraph", content: [{ type: "text", text: "Авторский текст", marks: [{ type: "bold" }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "Сохранённая ячейка" }] }] }] }] },
    ] };
    const created = await article({ document: rich, knowledge: "hypothesis", category: "Культура", tags: ["традиции"], sourceId: person.id });
    const saved = created.article!;
    expect(saved).toMatchObject({ worldId: world.id, version: 1, document: rich, knowledge: "hypothesis", category: "Культура", tags: ["традиции"] });
    const reread = await page(saved.id); expect(reread.status).toBe(200); expect(reread.data.article).toEqual(saved);
    expect((await page(saved.id, main.id, "9")).status).toBe(404);
    const updated = await owner.call<WikiPage>("PATCH", `/wiki-articles/${saved.id}${scope(main.id, "20")}`, { version: saved.version, title: "Другая редакция", document: document("Новая версия авторского текста") });
    expect(updated.status, JSON.stringify(updated.data)).toBe(200); expect(updated.data.article?.version).toBe(2);
    expect(updated.data.article).toMatchObject({ summary: saved.summary, category: "Культура", tags: ["традиции"], knowledge: "hypothesis", sourceId: person.id });
    expect((await page(saved.id, main.id, "10")).data.article).toEqual(saved);
    const stored = await database.query("SELECT r.data,r.deleted,o.kind FROM lore_revisions r JOIN lore_objects o ON o.id=r.object_id WHERE r.object_id=$1 ORDER BY r.revision", [saved.id]);
    expect(stored.rows).toHaveLength(2); expect(stored.rows[0]).toMatchObject({ kind: "wiki_articles", deleted: false, data: { document: rich } });
    await expect(database.query("UPDATE lore_revisions SET data='{}' WHERE object_id=$1", [saved.id])).rejects.toThrow(/immutable/i);
  });

  it("builds automatic cards from real characters, events and geography without creating article rows", async () => {
    const person = await character();
    const event = await owner.call<{ event: LoreEvent }>("POST", `/worlds/${world.id}/events${scope(main.id, "10")}`, { name: "Открытие библиотеки", startYear: 1200, characterIds: [person.id], description: "Связанное событие" });
    expect(event.status).toBe(201);
    const map = await owner.call<MapData>("POST", `/worlds/${world.id}/maps/generate${scope(main.id, "10")}`, { name: "Карта хранителя", seed: "wiki-auto-cards", preset: "island" });
    expect(map.status).toBe(201);
    const before = Number((await database.query("SELECT count(*) AS n FROM lore_objects WHERE world_id=$1", [world.id])).rows[0].n);
    const entries = await list();
    expect(new Set(entries.entries.map((entry) => entry.kind))).toEqual(new Set(["characters", "events", "maps", "map_features"]));
    expect(entries.entries.find((entry) => entry.id === person.id)).toMatchObject({ title: person.name, hasArticle: false });
    const card = await page(person.id); expect(card.status).toBe(200); expect(card.data.article).toBeNull();
    expect(JSON.stringify(card.data.facts)).toContain(person.biography);
    expect(card.data.related.some((entry) => entry.id === event.data.event.id)).toBe(true);
    expect((await page(map.data.map.id)).data.facts.length).toBeGreaterThan(0);
    expect((await page(map.data.features[0].id)).data.entry.kind).toBe("map_features");
    expect(Number((await database.query("SELECT count(*) AS n FROM lore_objects WHERE world_id=$1", [world.id])).rows[0].n)).toBe(before);
    expect((await list(main.id, "9")).entries).toEqual([]);
  });

  it("updates source facts while preserving the author's article text and historical context", async () => {
    const person = await character();
    const written = await article({ sourceId: person.id, document: document("Легенда автора, которую факты не должны переписать") });
    const changed = await owner.call<{ character: Character }>("PATCH", `/characters/${person.id}${scope(main.id, "20")}`, { version: person.version, biography: "Исправленная структурированная биография" });
    expect(changed.status).toBe(200);
    const current = (await page(written.article!.id)).data;
    expect(current.article!.document).toEqual(written.article!.document);
    expect(JSON.stringify(current.facts)).toContain("Исправленная структурированная биография");
    const earlier = (await page(written.article!.id, main.id, "10")).data;
    expect(JSON.stringify(earlier.facts)).toContain(person.biography);
    expect(JSON.stringify(earlier.facts)).not.toContain("Исправленная");
    expect((await page(person.id)).data.related.some((entry) => entry.id === written.article!.id)).toBe(true);
  });

  it("resolves internal links and reverse links in the selected historical slice", async () => {
    const target = await article({ title: "Книга истоков" });
    const linked = await article({ title: "Запись о книге", document: withLinks(target.article!.id) }, main.id, "20");
    expect((await page(target.article!.id, main.id, "10")).data.backlinks).toEqual([]);
    expect((await page(target.article!.id)).data.backlinks.map((entry) => entry.id)).toContain(linked.article!.id);
    const edited = await owner.call<WikiPage>("PATCH", `/wiki-articles/${linked.article!.id}${scope(main.id, "30")}`, { version: linked.article!.version, document: document("Ссылка убрана автором") });
    expect(edited.status).toBe(200);
    expect((await page(target.article!.id)).data.backlinks).toEqual([]);
    expect((await page(target.article!.id, main.id, "20")).data.backlinks.map((entry) => entry.id)).toContain(linked.article!.id);
  });

  it("uses a valid effective day for new visible references when editing the latest state without a day", async () => {
    const person = await character("Хранитель, появившийся позже", "30");
    const created = await owner.call<WikiPage>("POST", `/worlds/${world.id}/wiki${scope(main.id)}`, input({ sourceId: person.id, document: withLinks(person.id) }));
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    expect((await page(created.data.article!.id, main.id, "29")).status).toBe(404);
    expect((await page(created.data.article!.id, main.id, "30")).data.article?.sourceId).toBe(person.id);
    const earlier = await article({ document: document("Статья существовала до нового персонажа") });
    const changed = await owner.call<WikiPage>("PATCH", `/wiki-articles/${earlier.article!.id}${scope(main.id)}`, { version: 1, sourceId: person.id, document: { type: "doc", content: [{ type: "characterCard", attrs: { targetId: person.id } }] } });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    expect((await page(earlier.article!.id, main.id, "10")).data.article).toEqual(earlier.article);
    expect((await page(earlier.article!.id, main.id, "29")).data.article?.sourceId).toBeNull();
    expect((await page(earlier.article!.id, main.id, "30")).data.article?.sourceId).toBe(person.id);
    expect((await owner.call("POST", `/worlds/${world.id}/wiki${scope(main.id, "20")}`, input({ document: withLinks(person.id) }))).status).toBe(400);
  });

  it("searches article bodies with Russian full text and filters the resolved state rather than old revisions", async () => {
    const first = await article({ title: "Запись без ключа в заголовке", document: document("Серебряные драконы охраняют древнюю библиотеку"), category: "Мифы", tags: ["стражи"], knowledge: "rumor" });
    const other = await article({ title: "Другая статья", category: "Культура", tags: ["ритуалы"], knowledge: "fact", document: document("Только другое содержимое") });
    expect((await list(main.id, undefined, { q: "дракон" })).entries.map((entry) => entry.id)).toEqual([first.article!.id]);
    expect((await list(main.id, undefined, { category: "Мифы", tag: "стражи", knowledge: "rumor", kind: "articles" })).entries.map((entry) => entry.id)).toEqual([first.article!.id]);
    const branch = await fork();
    const edited = await owner.call<WikiPage>("PATCH", `/wiki-articles/${first.article!.id}${scope(main.id, "12")}`, { version: first.article!.version, document: document("Текст задним числом полностью заменён") });
    expect(edited.status).toBe(200);
    expect((await list(main.id, undefined, { q: "дракон" })).entries).toEqual([]);
    expect((await list(branch.id, undefined, { q: "дракон" })).entries.map((entry) => entry.id)).toEqual([first.article!.id]);
    const filtered = await list(main.id, undefined, { tag: "ритуалы" });
    expect(filtered.entries.map((entry) => entry.id)).toEqual([other.article!.id]);
    expect(filtered.categories).toContain("Культура");
  });

  it("pins late and backdated parent edits through nested branches and keeps child article edits independent", async () => {
    const original = await article({ document: document("Исходный текст ветвления") });
    const child = await fork(); const grandchild = await fork(child.id, "20");
    const parentChanged = await owner.call<WikiPage>("PATCH", `/wiki-articles/${original.article!.id}${scope(main.id, "12")}`, { version: original.article!.version, title: "Позднее задним числом", document: document("Поздний родитель") });
    expect(parentChanged.status).toBe(200);
    const future = await article({ title: "Поздно созданная запись" }, main.id, "11");
    expect((await page(original.article!.id, child.id)).data.article).toEqual(original.article);
    expect((await page(original.article!.id, grandchild.id)).data.article).toEqual(original.article);
    expect((await page(future.article!.id, child.id)).status).toBe(404);
    const local = await owner.call<WikiPage>("PATCH", `/wiki-articles/${original.article!.id}${scope(child.id, "25")}`, { version: original.article!.version, document: document("Собственное продолжение дочерней истории") });
    expect(local.status, JSON.stringify(local.data)).toBe(200);
    expect((await page(original.article!.id, main.id)).data.article?.document).toEqual(parentChanged.data.article?.document);
    expect((await page(original.article!.id, grandchild.id)).data.article).toEqual(original.article);
    const independent = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name: "Независимая энциклопедия" });
    expect(independent.status).toBe(201); expect((await list(independent.data.timeline.id)).entries).toEqual([]);
    const beforeFork = await owner.call("POST", `/worlds/${world.id}/wiki${scope(child.id, "14")}`, input());
    expect(beforeFork.status).toBe(400);
  });

  it("retains revision history and logical deletions without exposing revisions past a pin or selected day", async () => {
    const first = await article(); const child = await fork();
    const second = await owner.call<WikiPage>("PATCH", `/wiki-articles/${first.article!.id}${scope(main.id, "20")}`, { version: first.article!.version, summary: "Вторая версия" });
    expect(second.status).toBe(200);
    const removed = await owner.call("DELETE", `/wiki-articles/${first.article!.id}${scope(main.id, "30")}`, { version: second.data.article!.version });
    expect(removed.status).toBe(200); expect((await page(first.article!.id)).status).toBe(404);
    expect((await page(first.article!.id, main.id, "20")).data.article?.summary).toBe("Вторая версия");
    expect((await page(first.article!.id, child.id)).data.article).toEqual(first.article);
    const history = await owner.call<WikiHistory>("GET", `/wiki-articles/${first.article!.id}/history${scope(main.id)}`);
    expect(history.status, JSON.stringify(history.data)).toBe(200);
    expect(history.data.revisions).toHaveLength(3); expect(history.data.revisions.some((revision) => revision.deleted)).toBe(true);
    const pinned = await owner.call<WikiHistory>("GET", `/wiki-articles/${first.article!.id}/history${scope(child.id)}`);
    expect(pinned.status).toBe(200); expect(pinned.data.revisions).toHaveLength(1);
    const earlier = await owner.call<WikiHistory>("GET", `/wiki-articles/${first.article!.id}/history${scope(main.id, "10")}`);
    expect(earlier.status).toBe(200); expect(earlier.data.revisions).toHaveLength(1);
    expect((await owner.call("PATCH", `/wiki-articles/${first.article!.id}${scope(main.id, "20", first.revision)}`, { version: 1, title: "Запись в immutable snapshot" })).status).toBe(400);
  });

  it("rejects stale versions atomically and leaves the successful author's text intact", async () => {
    const first = await article();
    const changed = await owner.call<WikiPage>("PATCH", `/wiki-articles/${first.article!.id}${scope(main.id, "20")}`, { version: 1, title: "Сохранённая правка первого автора" });
    expect(changed.status).toBe(200);
    const before = (await database.query("SELECT count(*) AS n FROM lore_revisions WHERE object_id=$1", [first.article!.id])).rows[0].n;
    expect((await owner.call("PATCH", `/wiki-articles/${first.article!.id}${scope(main.id, "20")}`, { version: 1, title: "Потерянная конкурентная правка" })).status).toBe(409);
    expect((await owner.call("DELETE", `/wiki-articles/${first.article!.id}${scope(main.id, "20")}`, { version: 1 })).status).toBe(409);
    expect((await page(first.article!.id)).data.article?.title).toBe("Сохранённая правка первого автора");
    expect((await database.query("SELECT count(*) AS n FROM lore_revisions WHERE object_id=$1", [first.article!.id])).rows[0].n).toBe(before);
  });

  it("enforces project roles, privacy, foreign Origin and foreign timeline context", async () => {
    const written = await article({ knowledge: "secret" });
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, readerId]);
    try {
      expect((await anonymous.call("GET", `/worlds/${world.id}/wiki`)).status).toBe(401);
      expect((await stranger.call("GET", `/worlds/${world.id}/wiki`)).status).toBe(404);
      expect((await stranger.call("GET", `/worlds/${world.id}/wiki/${written.article!.id}`)).status).toBe(404);
      expect((await reader.call<WikiPage>("GET", `/worlds/${world.id}/wiki/${written.article!.id}`)).data.article?.knowledge).toBe("secret");
      expect((await reader.call("POST", `/worlds/${world.id}/wiki`, input())).status).toBe(403);
      expect((await reader.call("PATCH", `/wiki-articles/${written.article!.id}`, { version: 1, title: "Нет права" })).status).toBe(403);
      expect((await reader.call("DELETE", `/wiki-articles/${written.article!.id}`, { version: 1 })).status).toBe(403);
      expect((await owner.call("POST", `/worlds/${world.id}/wiki`, input(), "https://foreign-origin.example")).status).toBe(403);
      expect((await owner.call("GET", `/worlds/${world.id}/wiki${scope(foreignMain.id)}`)).status).toBe(404);
    } finally { await database.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [project.id, readerId]); }
  });

  it("validates source/link/embed targets in the same visible world and rejects invalid documents atomically", async () => {
    const person = await character();
    const before = Number((await database.query("SELECT count(*) AS n FROM lore_objects WHERE world_id=$1 AND kind='wiki_articles'", [world.id])).rows[0].n);
    const invalids: unknown[] = [
      { sourceId: foreignCharacter.id }, { sourceId: randomUUID() },
      { document: withLinks(foreignCharacter.id) }, { document: withLinks(randomUUID()) },
      { document: { type: "doc", content: [{ type: "mapEmbed", attrs: { targetId: person.id } }] } },
      { document: { type: "doc", content: [{ type: "script", text: "alert(1)" }] } },
      { document: { type: "doc", content: [{ type: "paragraph", attrs: { onclick: "alert(1)" }, content: [] }] } },
      { document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "опасная ссылка", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] } },
      { document: { type: "doc", content: [{ type: "image", attrs: { src: "https://tracker.example/secret.png" } }] } },
      { document: { type: "doc", content: [{ type: "image", attrs: { src: "data:image/png;base64,AA==" } }] } },
      { document: document("x".repeat(100001)) }, { knowledge: "unknown" },
    ];
    for (const invalid of invalids) {
      const response = await owner.call("POST", `/worlds/${world.id}/wiki${scope(main.id, "10")}`, { ...input(), ...invalid as object });
      expect(response.status, JSON.stringify(response.data)).toBe(400);
    }
    expect(Number((await database.query("SELECT count(*) AS n FROM lore_objects WHERE world_id=$1 AND kind='wiki_articles'", [world.id])).rows[0].n)).toBe(before);
    const embedded = await article({ sourceId: person.id, document: { type: "doc", content: [{ type: "characterCard", attrs: { targetId: person.id } }] } });
    expect(embedded.article!.sourceId).toBe(person.id);
    const future = await character("Персонаж будущего", "30");
    expect((await owner.call("POST", `/worlds/${world.id}/wiki${scope(main.id, "10")}`, input({ sourceId: future.id }))).status).toBe(400);
  });

  it("keeps archived author links editable after target deletion but forbids assigning unavailable new targets", async () => {
    const target = await article({ title: "Исторически удалённая цель" });
    const linked = await article({ document: withLinks(target.article!.id) });
    expect((await owner.call("DELETE", `/wiki-articles/${target.article!.id}${scope(main.id, "20")}`, { version: 1 })).status).toBe(200);
    const current = await page(linked.article!.id);
    expect(current.status).toBe(200); expect(current.data.targets.some((entry) => entry.id === target.article!.id)).toBe(false);
    const preserved = await owner.call<WikiPage>("PATCH", `/wiki-articles/${linked.article!.id}${scope(main.id, "30")}`, { version: 1, summary: "Описание отредактировано, архивная ссылка сохранена" });
    expect(preserved.status, JSON.stringify(preserved.data)).toBe(200);
    expect(preserved.data.article!.document).toEqual(linked.article!.document);
    expect((await owner.call("POST", `/worlds/${world.id}/wiki${scope(main.id, "30")}`, input({ document: withLinks(target.article!.id) }))).status).toBe(400);
  });

  it("stores a decoded local WebP and serves exact private bytes only to project members", async () => {
    const uploaded = await upload();
    expect(uploaded.image).toMatchObject({ url: `/api/wiki-images/${uploaded.image.id}`, width: 18, height: 12 });
    const image = await owner.image("GET", `/wiki-images/${uploaded.image.id}`);
    expect(image.status).toBe(200); expect(image.headers.get("content-type")).toContain("image/webp");
    expect(image.headers.get("cache-control")).toContain("no-store"); expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await image.arrayBuffer());
    expect(uploaded.image.bytes).toBe(bytes.length); expect(await sharp(bytes).metadata()).toMatchObject({ format: "webp", width: 18, height: 12 });
    const stored = (await database.query("SELECT bytes,content_type,world_id FROM wiki_images WHERE id=$1", [uploaded.image.id])).rows[0];
    expect(stored.world_id).toBe(world.id); expect(stored.content_type).toBe("image/webp"); expect(hash(stored.bytes)).toBe(hash(bytes));
    await expect(database.query("UPDATE wiki_images SET bytes=$1,byte_size=$2 WHERE id=$3", [Buffer.from("replacement"), 11, uploaded.image.id])).rejects.toThrow(/immutable/i);
    await expect(database.query("DELETE FROM wiki_images WHERE id=$1", [uploaded.image.id])).rejects.toThrow(/immutable/i);
    expect((await stranger.image("GET", `/wiki-images/${uploaded.image.id}`)).status).toBe(404);
    expect((await anonymous.image("GET", `/wiki-images/${uploaded.image.id}`)).status).toBe(401);
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, readerId]);
    try {
      const readable = await reader.image("GET", `/wiki-images/${uploaded.image.id}`); expect(readable.status).toBe(200); expect(hash(Buffer.from(await readable.arrayBuffer()))).toBe(hash(bytes));
      expect((await reader.image("POST", `/worlds/${world.id}/wiki/images`, uploaded.original)).status).toBe(403);
    } finally { await database.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [project.id, readerId]); }
  });

  it("rejects malformed, disguised, oversized and foreign-Origin media without storing assets", async () => {
    const before = (await database.query("SELECT count(*) AS n FROM wiki_images WHERE world_id=$1", [world.id])).rows[0].n;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#aaff88" } }).png().toBuffer();
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, png, "image/jpeg")).status).toBe(400);
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml")).status).toBe(415);
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, Buffer.from("not a decoded PNG"))).status).toBe(400);
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, Buffer.alloc(0))).status).toBe(400);
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, png, "image/png", "https://foreign-origin.example")).status).toBe(403);
    const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "#123456" } }).png().toBuffer();
    expect((await owner.image("POST", `/worlds/${world.id}/wiki/images`, wide)).status).toBe(400);
    expect((await database.query("SELECT count(*) AS n FROM wiki_images WHERE world_id=$1", [world.id])).rows[0].n).toBe(before);
  });

  it("validates image ownership and retains image bytes for historical article revisions after deletion", async () => {
    const own = await upload(); const foreign = await upload(stranger, foreignWorld.id, "#996633");
    const imageDoc: WikiDocument = { type: "doc", content: [{ type: "image", attrs: { src: own.image.url, alt: "Старинная иллюстрация", title: "Иллюстрация" } }] };
    const written = await article({ document: imageDoc });
    expect(written.article!.document).toEqual(imageDoc);
    const bad = await owner.call("POST", `/worlds/${world.id}/wiki`, input({ document: { type: "doc", content: [{ type: "image", attrs: { src: foreign.image.url } }] } }));
    expect(bad.status).toBe(400);
    expect((await owner.call("POST", `/worlds/${world.id}/wiki`, input({ document: { type: "doc", content: [{ type: "image", attrs: { src: `/api/wiki-images/${randomUUID()}` } }] } }))).status).toBe(400);
    const before = await owner.image("GET", `/wiki-images/${own.image.id}`); const bytes = Buffer.from(await before.arrayBuffer());
    const changed = await owner.call<WikiPage>("PATCH", `/wiki-articles/${written.article!.id}${scope(main.id, "20")}`, { version: 1, document: document("Иллюстрация убрана из новой редакции") });
    expect(changed.status).toBe(200);
    expect((await owner.call("DELETE", `/wiki-articles/${written.article!.id}${scope(main.id, "30")}`, { version: changed.data.article!.version })).status).toBe(200);
    const earlier = await page(written.article!.id, main.id, "10"); expect(earlier.data.article!.document).toEqual(imageDoc);
    const retained = await owner.image("GET", `/wiki-images/${own.image.id}`); expect(retained.status).toBe(200); expect(hash(Buffer.from(await retained.arrayBuffer()))).toBe(hash(bytes));
  });
});
