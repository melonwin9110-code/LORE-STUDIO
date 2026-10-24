import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { Character, LoreEvent, Project, Relation, User, World, WorldData } from "../../src/lib/types";
import type { CalendarRecord, Difference, Revision, Timeline } from "../../src/lib/history-types";
import type { CalendarDefinition } from "../../src/lib/calendar";
import { gregorianYearDay } from "../../src/lib/calendar";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3001";
const origin = new URL(base).origin;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "History-test-password-2026!";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)))) {
  throw new Error("History role fixtures require a dedicated database ending in _test");
}
const database = new pg.Pool({ connectionString: databaseUrl });

class Client {
  cookie = "";
  async call<T = { error?: string }>(method: string, path: string, input?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { Origin: origin, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      redirect: "manual",
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
    const data = await response.json() as T;
    return { status: response.status, data };
  }
}
const context = (timeline: string, day?: string, revision?: string) => {
  const params = new URLSearchParams({ timeline });
  if (day !== undefined) params.set("day", day);
  if (revision !== undefined) params.set("revision", revision);
  return `?${params}`;
};
const atYear = (year: number) => gregorianYearDay(year).toString();
const customCalendar: CalendarDefinition = {
  name: "Календарь двух лун", era: "Эра рассвета", epochOffset: "10",
  months: [{ name: "Первая луна", days: 20 }, { name: "Вторая луна", days: 25 }],
  leap: { every: 3, exceptEvery: null, includeEvery: null, month: 2, days: 1, offset: 0 },
};

// Each test gets a separate world. Only projects created by this run are removed.
describe("historical state, pinned branches and cross-line integrity", () => {
  const owner = new Client(), stranger = new Client(), anonymous = new Client();
  let project: Project, foreignProject: Project, strangerId: string;
  let world: World, foreignWorld: World, main: Timeline, foreignMain: Timeline;

  async function state(worldId = world.id, line = main.id, day?: string, revision?: string) {
    const result = await owner.call<WorldData>("GET", `/worlds/${worldId}${context(line, day, revision)}`);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    expect(result.data.history).toBeDefined();
    return result.data;
  }
  async function ownWorld(name: string, projectId = project.id) {
    const result = await owner.call<{ world: World }>("POST", `/projects/${projectId}/worlds`, { name });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    const loaded = await owner.call<WorldData>("GET", `/worlds/${result.data.world.id}`);
    expect(loaded.status).toBe(200);
    expect(loaded.data.history).toBeDefined();
    return { world: result.data.world, main: loaded.data.history!.timeline };
  }
  async function character(name: string, line = main.id, day = "10", extra: Record<string, unknown> = {}) {
    const result = await owner.call<{ character: Character }>("POST", `/worlds/${world.id}/characters${context(line, day)}`, { name, ...extra });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data.character;
  }
  async function edit(character: Character, biography: string, line = main.id, day = "20") {
    const result = await owner.call<{ character: Character }>("PATCH", `/characters/${character.id}${context(line, day)}`, { biography, version: character.version });
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return result.data.character;
  }
  async function fork(parentId = main.id, day = "100", name = "Альтернативная история") {
    const loaded = await state(world.id, parentId);
    const result = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, {
      name, parentId, forkDay: day, expectedParentRevision: loaded.history!.timeline.headRevision,
    });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data.timeline;
  }
  async function independent(name = "Независимая история") {
    const result = await owner.call<{ timeline: Timeline }>("POST", `/worlds/${world.id}/timelines`, { name });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    return result.data.timeline;
  }
  async function relation(from: Character, to: Character, input: Record<string, unknown> = {}, day = "10", line = main.id) {
    return owner.call<{ relation: Relation }>("POST", `/worlds/${world.id}/relations${context(line, day)}`, {
      fromId: from.id, toId: to.id, kind: "Родитель", familyKind: "parent", mutual: false, ...input,
    });
  }

  beforeAll(async () => {
    for (const [client, name] of [[owner, "owner"], [stranger, "stranger"]] as const) {
      const result = await client.call<{ user: User }>("POST", "/auth/register", { name, email: `history-${name}-${suffix}@example.test`, password });
      expect(result.status).toBe(201);
      if (client === stranger) strangerId = result.data.user.id;
    }
    const own = await owner.call<{ project: Project }>("POST", "/projects", { name: "Исторические тесты" });
    expect(own.status).toBe(201); project = own.data.project;
    const other = await stranger.call<{ project: Project }>("POST", "/projects", { name: "Закрытая история" });
    expect(other.status).toBe(201); foreignProject = other.data.project;
    const created = await stranger.call<{ world: World }>("POST", `/projects/${foreignProject.id}/worlds`, { name: "Чужая вселенная" });
    expect(created.status).toBe(201); foreignWorld = created.data.world;
    const loaded = await stranger.call<WorldData>("GET", `/worlds/${foreignWorld.id}`);
    expect(loaded.status).toBe(200); foreignMain = loaded.data.history!.timeline;
  }, 60_000);
  beforeEach(async () => {
    const created = await ownWorld("Мир отдельной проверки");
    world = created.world; main = created.main;
  });
  afterAll(async () => {
    if (project) await owner.call("DELETE", `/projects/${project.id}`);
    if (foreignProject) await stranger.call("DELETE", `/projects/${foreignProject.id}`);
    await owner.call("POST", "/auth/logout");
    await stranger.call("POST", "/auth/logout");
    await database.end();
  });

  it("initializes each world with its main line and an immutable default Gregorian calendar", async () => {
    const initial = await state();
    expect(initial.history!.timeline.isMain).toBe(true);
    expect(initial.history!.timeline.worldId).toBe(world.id);
    expect(initial.history!.timeline.parentId).toBeNull();
    expect(initial.history!.calendars.filter((calendar) => calendar.isDefault)).toHaveLength(1);
    const listed = await owner.call<{ calendars: CalendarRecord[] }>("GET", `/worlds/${world.id}/calendars`);
    expect(listed.status).toBe(200);
    expect(listed.data.calendars[0].definition.months).toHaveLength(12);
    const saved = await owner.call<{ calendar: CalendarRecord }>("POST", `/worlds/${world.id}/calendars`, { definition: customCalendar });
    expect(saved.status, JSON.stringify(saved.data)).toBe(201);
    expect(saved.data.calendar.definition).toEqual(customCalendar);
    expect(saved.data.calendar.isDefault).toBe(false);
    const reloaded = await state();
    expect(reloaded.history!.calendars.find((calendar) => calendar.id === saved.data.calendar.id)?.definition).toEqual(customCalendar);
    for (const definition of [
      { ...customCalendar, months: [] },
      { ...customCalendar, months: [{ name: "Ошибка", days: 0 }] },
      { ...customCalendar, leap: { ...customCalendar.leap!, month: 3 } },
      { ...customCalendar, epochOffset: "NaN" },
    ]) expect((await owner.call("POST", `/worlds/${world.id}/calendars`, { definition })).status).toBe(400);
    expect((await state()).history!.calendars).toHaveLength(2);
  });

  it("rejects malformed ordinal and revision strings as validation errors", async () => {
    for (const query of ["day=NaN", "day=1.5", "day=01", "day=1000000000000001", "revision=NaN", "revision=-1", "revision=9223372036854775808"]) {
      const result = await owner.call("GET", `/worlds/${world.id}?timeline=${main.id}&${query}`);
      expect(result.status, `Query ${query}: ${JSON.stringify(result.data)}`).toBe(400);
    }
    expect((await owner.call("POST", `/worlds/${world.id}/timelines`, {
      name: "Некорректная дата", parentId: main.id, forkDay: "NaN", expectedParentRevision: main.headRevision,
    })).status).toBe(400);
    expect((await state()).history!.timelines).toHaveLength(1);
  });

  it("resolves immutable property versions by effective day and selected saved revision", async () => {
    const first = await character("Лиора", main.id, "10", { biography: "Ученица" });
    const oldHead = (await state()).history!.timeline.headRevision;
    const next = await edit(first, "Хранительница", main.id, "20");
    expect(next.version).toBeGreaterThan(first.version);
    expect((await state(world.id, main.id, "9")).characters).toHaveLength(0);
    expect((await state(world.id, main.id, "19")).characters[0].biography).toBe("Ученица");
    expect((await state(world.id, main.id, "20")).characters[0].biography).toBe("Хранительница");
    expect((await state(world.id, main.id, "30", oldHead)).characters[0].biography).toBe("Ученица");
    expect((await state()).characters[0].biography).toBe("Хранительница");
    const history = await owner.call<{ revisions: Revision[] }>("GET", `/characters/${first.id}/history${context(main.id)}`);
    expect(history.status).toBe(200);
    expect(history.data.revisions.map((revision) => revision.effectiveDay).sort()).toEqual(["10", "20"]);
    expect(history.data.revisions.some((revision) => revision.data?.biography === "Ученица")).toBe(true);
    expect(history.data.revisions.some((revision) => revision.data?.biography === "Хранительница")).toBe(true);
    expect((await owner.call("PATCH", `/characters/${first.id}${context(main.id, "20", oldHead)}`, { biography: "Недопустимая запись в снимок", version: next.version })).status).toBe(400);
    expect((await state()).characters[0].biography).toBe("Хранительница");
  });

  it("changes a relationship in one era without rewriting its past or a pinned branch", async () => {
    const first = await character("Первый союзник"), second = await character("Второй союзник");
    const created = await relation(first, second, { kind: "Дружба", familyKind: "other", mutual: true });
    expect(created.status).toBe(201);
    const original = created.data.relation;
    const forked = await fork(main.id, "15");
    const changed = await owner.call<{ relation: Relation }>("PATCH", `/relations/${original.id}${context(main.id, "20")}`, {
      kind: "Вражда", mutual: false, version: original.version,
    });
    expect(changed.status).toBe(200);
    expect((await state(world.id, main.id, "19")).relations[0]).toMatchObject({ id: original.id, kind: "Дружба", mutual: true });
    expect((await state(world.id, main.id, "20")).relations[0]).toMatchObject({ id: original.id, kind: "Вражда", mutual: false });
    expect((await state(world.id, forked.id, "100")).relations[0]).toMatchObject({ id: original.id, kind: "Дружба", mutual: true });
    const history = await owner.call<{ revisions: Revision[] }>("GET", `/relations/${original.id}/history${context(main.id)}`);
    expect(history.status).toBe(200);
    expect(history.data.revisions.map((revision) => revision.data?.kind).sort()).toEqual(["Вражда", "Дружба"].sort());
  });

  it("pins parent revision and fork day, excluding known future versions and later backdated parent edits", async () => {
    const initial = await character("Аэрен", main.id, "10", { biography: "Курсант" });
    const future = await edit(initial, "Адмирал будущего", main.id, "200");
    const forked = await fork(main.id, "100");
    const pinnedHead = forked.parentRevision;
    expect(pinnedHead).toBe((await state()).history!.timeline.headRevision);
    expect((await state(world.id, forked.id, "300")).characters[0].biography).toBe("Курсант");
    const backdated = await edit(initial, "Исправленная прошлая биография", main.id, "50");
    expect((await state(world.id, main.id, "100")).characters[0].biography).toBe(backdated.biography);
    expect((await state(world.id, forked.id, "300")).characters[0].biography).toBe("Курсант");
    await edit(future, "Переписанное будущее", main.id, "200");
    const childCharacter = (await state(world.id, forked.id, "150")).characters[0];
    await edit(childCharacter, "Капитан альтернативной ветки", forked.id, "150");
    expect((await state(world.id, forked.id, "149")).characters[0].biography).toBe("Курсант");
    expect((await state(world.id, forked.id, "150")).characters[0].biography).toBe("Капитан альтернативной ветки");
    expect((await state(world.id, main.id, "150")).characters[0].biography).toBe("Исправленная прошлая биография");
    const childHistory = await owner.call<{ revisions: Revision[] }>("GET", `/characters/${initial.id}/history${context(forked.id)}`);
    expect(childHistory.status).toBe(200);
    expect(childHistory.data.revisions.map((revision) => revision.data?.biography)).not.toContain("Адмирал будущего");
    expect(childHistory.data.revisions.map((revision) => revision.data?.biography)).not.toContain("Исправленная прошлая биография");
    expect((await owner.call("POST", `/worlds/${world.id}/timelines`, { name: "Устаревший снимок", parentId: main.id, forkDay: "100", expectedParentRevision: pinnedHead })).status).toBe(409);
  });

  it("supports nested forks, independent empty histories and canonical flags", async () => {
    const first = await character("Мира", main.id, "10", { biography: "Исходная история" });
    const child = await fork(main.id, "20", "Ответвление");
    const childChanged = await edit(first, "История дочерней линии", child.id, "30");
    const nested = await fork(child.id, "40", "Ветка третьего уровня");
    await edit(childChanged, "Поздняя правка родителя ветки", child.id, "35");
    expect((await state(world.id, nested.id, "60")).characters[0].biography).toBe("История дочерней линии");
    const independentLine = await independent();
    expect((await state(world.id, independentLine.id)).characters).toHaveLength(0);
    expect((await state(world.id, independentLine.id)).events).toHaveLength(0);
    expect((await state(world.id, independentLine.id)).relations).toHaveLength(0);
    const renamed = await owner.call<{ timeline: Timeline }>("PATCH", `/timelines/${independentLine.id}`, { name: "Вторая каноническая история", isCanon: true });
    expect(renamed.status).toBe(200);
    expect(renamed.data.timeline.isCanon).toBe(true);
    expect(renamed.data.timeline.name).toBe("Вторая каноническая история");
    expect((await state()).history!.timelines.filter((line) => line.isMain)).toHaveLength(1);
    expect((await owner.call("POST", `/worlds/${world.id}/characters${context(child.id, "19")}`, { name: "До ответвления" })).status).toBe(400);
  });

  it("preserves earlier dates and other branches when a character and dependent links are deleted", async () => {
    const first = await character("Первый"), second = await character("Второй");
    const event = await owner.call<{ event: LoreEvent }>("POST", `/worlds/${world.id}/events${context(main.id, "10")}`, { name: "Встреча", startYear: 0, characterIds: [first.id, second.id] });
    expect(event.status).toBe(201);
    expect((await relation(first, second, { familyKind: "other", kind: "Дружба" })).status).toBe(201);
    const child = await fork(main.id, "15");
    expect((await owner.call("DELETE", `/characters/${first.id}${context(main.id, "20")}`)).status).toBe(200);
    const after = await state(world.id, main.id, "25");
    expect(after.characters.map((item) => item.id)).toEqual([second.id]);
    expect(after.events.find((item) => item.id === event.data.event.id)?.characterIds).toEqual([second.id]);
    expect(after.relations).toHaveLength(0);
    for (const [line, day] of [[main.id, "15"], [child.id, "25"]]) {
      const before = await state(world.id, line, day);
      expect(before.characters.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
      expect(before.events[0].characterIds.sort()).toEqual([first.id, second.id].sort());
      expect(before.relations).toHaveLength(1);
    }
    const history = await owner.call<{ revisions: Revision[] }>("GET", `/characters/${first.id}/history${context(main.id)}`);
    expect(history.status).toBe(200);
    expect(history.data.revisions.some((revision) => revision.deleted && revision.effectiveDay === "20")).toBe(true);
  });

  it("rejects one of two concurrent changes to the same visible historical revision", async () => {
    const first = await character("Авторская биография");
    const results = await Promise.all(["Первая редакция", "Вторая редакция"].map((biography) => owner.call<{ character: Character }>("PATCH", `/characters/${first.id}${context(main.id, "20")}`, { biography, version: first.version })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const accepted = results.find((result) => result.status === 200)!;
    expect((await state(world.id, main.id, "20")).characters[0].biography).toBe(accepted.data.character.biography);
    expect((await state(world.id, main.id, "10")).characters[0].biography).toBe("");
  });

  it("enforces privacy and world boundaries on every new endpoint", async () => {
    const first = await character("Скрытый персонаж");
    const sameOwnerOther = await ownWorld("Другой мир владельца");
    for (const [method, path, input] of [
      ["GET", `/worlds/${world.id}/timelines`, undefined],
      ["GET", `/worlds/${world.id}/calendars`, undefined],
      ["POST", `/worlds/${world.id}/timelines`, { name: "Посторонняя ветка" }],
      ["POST", `/worlds/${world.id}/calendars`, { definition: customCalendar }],
      ["PATCH", `/timelines/${main.id}`, { name: "Посторонняя правка" }],
      ["GET", `/timelines/${main.id}/compare?other=${main.id}`, undefined],
      ["POST", `/timelines/${main.id}/transfer`, { sourceId: main.id, objectIds: [first.id], expectedRevision: (await state()).history!.timeline.headRevision }],
      ["GET", `/characters/${first.id}/history${context(main.id)}`, undefined],
    ] as const) {
      expect((await anonymous.call(method, path, input)).status).toBe(401);
      expect((await stranger.call(method, path, input)).status).toBe(404);
    }
    for (const [method, path, input] of [
      ["GET", `/worlds/${world.id}${context(sameOwnerOther.main.id)}`, undefined],
      ["POST", `/worlds/${world.id}/characters${context(sameOwnerOther.main.id)}`, { name: "Чужая линия" }],
      ["PATCH", `/characters/${first.id}${context(sameOwnerOther.main.id)}`, { biography: "Чужая линия", version: first.version }],
      ["GET", `/characters/${first.id}/history${context(sameOwnerOther.main.id)}`, undefined],
      ["GET", `/worlds/${world.id}${context(foreignMain.id)}`, undefined],
    ] as const) expect((await owner.call(method, path, input)).status).toBe(404);
    expect((await owner.call("GET", `/timelines/${main.id}/compare?other=${foreignMain.id}`)).status).toBe(404);
    expect((await owner.call("POST", `/timelines/${main.id}/transfer`, { sourceId: sameOwnerOther.main.id, objectIds: [first.id], expectedRevision: (await state()).history!.timeline.headRevision })).status).toBe(400);
  });

  it("allows reader history views and rejects reader timeline, calendar and object writes", async () => {
    const first = await character("Герой читателя");
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'reader')", [project.id, strangerId]);
    try {
      expect((await stranger.call("GET", `/worlds/${world.id}/timelines`)).status).toBe(200);
      expect((await stranger.call("GET", `/worlds/${world.id}/calendars`)).status).toBe(200);
      expect((await stranger.call("GET", `/characters/${first.id}/history${context(main.id)}`)).status).toBe(200);
      for (const [method, path, input] of [
        ["POST", `/worlds/${world.id}/timelines`, { name: "Запрещено" }],
        ["POST", `/worlds/${world.id}/calendars`, { definition: customCalendar }],
        ["PATCH", `/timelines/${main.id}`, { isCanon: false }],
        ["POST", `/timelines/${main.id}/transfer`, { sourceId: main.id, objectIds: [first.id], expectedRevision: (await state()).history!.timeline.headRevision }],
        ["PATCH", `/characters/${first.id}${context(main.id, "20")}`, { biography: "Читатель не редактор", version: first.version }],
      ] as const) expect((await stranger.call(method, path, input)).status).toBe(403);
    } finally { await database.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [project.id, strangerId]); }
  });

  it("rejects ancestry cycles and known biological chronology contradictions", async () => {
    const first = await character("Предок"), second = await character("Потомок"), third = await character("Третье поколение");
    expect((await relation(first, second)).status).toBe(201);
    expect((await relation(second, third)).status).toBe(201);
    expect((await relation(third, first)).status).toBe(400);
    expect((await state()).relations).toHaveLength(2);
    const youngParent = await character("Слишком молодой родитель", main.id, "10", { birthYear: 30 });
    const olderChild = await character("Старший ребёнок", main.id, "10", { birthYear: 20 });
    expect((await relation(youngParent, olderChild)).status).toBe(400);
    expect((await relation(youngParent, olderChild, { familyKind: "adoptive_parent", kind: "Усыновление" })).status).toBe(201);
    const deceasedParent = await character("Умерший родитель", main.id, "10", { birthYear: 0, deathYear: 10 });
    expect((await relation(deceasedParent, olderChild)).status).toBe(400);
  });

  it("checks future historical breakpoints but accepts ancestry edges whose intervals never overlap", async () => {
    const first = await character("Первый предок"), second = await character("Второй предок");
    expect((await relation(first, second, {}, "200")).status).toBe(201);
    expect((await relation(second, first, {}, "100")).status).toBe(400);
    expect((await state(world.id, main.id, "150")).relations).toHaveLength(0);
    expect((await state(world.id, main.id, "250")).relations).toHaveLength(1);
    const third = await character("Третий предок"), fourth = await character("Четвёртый предок");
    expect((await relation(third, fourth, { startYear: 0, endYear: 10 }, "10")).status).toBe(201);
    expect((await relation(fourth, third, { startYear: 11, endYear: 20 }, "10")).status).toBe(201);
    expect((await state(world.id, main.id, atYear(5))).relations.filter((item) => [third.id, fourth.id].includes(item.fromId))).toHaveLength(1);
    expect((await state(world.id, main.id, atYear(15))).relations.filter((item) => [third.id, fourth.id].includes(item.fromId))).toHaveLength(1);
  });

  it("rejects historical character edits that contradict already recorded parenthood", async () => {
    const parent = await character("Родитель", main.id, "10", { birthYear: 0 });
    const child = await character("Ребёнок", main.id, "10", { birthYear: 20 });
    expect((await relation(parent, child)).status).toBe(201);
    expect((await owner.call("PATCH", `/characters/${parent.id}${context(main.id, "100")}`, { birthYear: 25, version: parent.version })).status).toBe(400);
    expect((await state(world.id, main.id, "100")).characters.find((item) => item.id === parent.id)?.birthYear).toBe(0);
  });

  it("rejects transfer when the compared source revision changes before confirmation", async () => {
    const first = await character("Подтверждаемый источник", main.id, "10", { biography: "Просмотренная версия" });
    const target = await independent("Получатель подтверждённой версии");
    type Comparison = { leftRevision: string; rightRevision: string; differences: Difference[] };
    const compared = await owner.call<Comparison>("GET", `/timelines/${target.id}/compare?other=${main.id}&day=10`);
    expect(compared.status).toBe(200);
    expect(compared.data.leftRevision).toBe((await state(world.id, target.id)).history!.timeline.headRevision);
    expect(compared.data.rightRevision).toBe((await state()).history!.timeline.headRevision);
    expect(compared.data.differences.some((difference) => difference.id === first.id)).toBe(true);
    const changed = await edit(first, "Изменено после просмотра", main.id, "10");
    const stale = await owner.call("POST", `/timelines/${target.id}/transfer`, {
      sourceId: main.id, sourceDay: "10", targetDay: "10", objectIds: [first.id],
      expectedRevision: compared.data.leftRevision, expectedSourceRevision: compared.data.rightRevision,
    });
    expect(stale.status, JSON.stringify(stale.data)).toBe(409);
    const untouchedTarget = await state(world.id, target.id, "10");
    expect(untouchedTarget.characters).toHaveLength(0);
    expect(untouchedTarget.history!.timeline.headRevision).toBe(compared.data.leftRevision);
    const sourceAfterFailure = (await state(world.id, main.id, "10")).characters.find((item) => item.id === first.id)!;
    expect(sourceAfterFailure.biography).toBe(changed.biography);
    expect(sourceAfterFailure.version).toBe(changed.version);
    const refreshed = await owner.call<Comparison>("GET", `/timelines/${target.id}/compare?other=${main.id}&day=10`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.data.leftRevision).toBe(compared.data.leftRevision);
    expect(refreshed.data.rightRevision).not.toBe(compared.data.rightRevision);
    const confirmed = await owner.call<{ ok: boolean; transferred: number }>("POST", `/timelines/${target.id}/transfer`, {
      sourceId: main.id, sourceDay: "10", targetDay: "10", objectIds: [first.id],
      expectedRevision: refreshed.data.leftRevision, expectedSourceRevision: refreshed.data.rightRevision,
    });
    expect(confirmed.status, JSON.stringify(confirmed.data)).toBe(200);
    expect(confirmed.data.transferred).toBe(1);
    expect((await state(world.id, target.id, "10")).characters.find((item) => item.id === first.id)?.biography).toBe(changed.biography);
    expect((await state(world.id, main.id, "10")).characters.find((item) => item.id === first.id)?.version).toBe(changed.version);
  });

  it("transfers stable linked identities atomically, compares semantic data and requires conflict confirmation", async () => {
    const first = await character("Переносимый герой", main.id, "10", { biography: "Исходная биография" });
    const second = await character("Спутник");
    const event = await owner.call<{ event: LoreEvent }>("POST", `/worlds/${world.id}/events${context(main.id, "10")}`, { name: "Совместное событие", startYear: 0, characterIds: [first.id, second.id] });
    expect(event.status).toBe(201);
    const link = await relation(first, second, { familyKind: "other", kind: "Дружба" });
    expect(link.status).toBe(201);
    const target = await independent();
    const transfer = async (objectIds: string[], input: Record<string, unknown> = {}) => owner.call<{ ok: boolean; transferred: number }>("POST", `/timelines/${target.id}/transfer`, {
      sourceId: main.id, sourceDay: "10", targetDay: "10", objectIds,
      expectedRevision: (await state(world.id, target.id)).history!.timeline.headRevision, ...input,
    });
    expect((await transfer([event.data.event.id])).status).toBe(400);
    expect((await state(world.id, target.id)).characters).toHaveLength(0);
    const copied = await transfer([event.data.event.id, link.data.relation.id], { includeDependencies: true });
    expect(copied.status, JSON.stringify(copied.data)).toBe(200);
    expect(copied.data.transferred).toBe(4);
    const targetState = await state(world.id, target.id, "10");
    expect(targetState.characters.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(targetState.events[0].id).toBe(event.data.event.id);
    expect(targetState.events[0].characterIds.sort()).toEqual([first.id, second.id].sort());
    expect(targetState.relations[0].id).toBe(link.data.relation.id);
    const identical = await owner.call<{ differences: Difference[] }>("GET", `/timelines/${target.id}/compare?other=${main.id}&day=10`);
    expect(identical.status).toBe(200);
    expect(identical.data.differences).toHaveLength(0);
    const targetCharacter = targetState.characters.find((item) => item.id === first.id)!;
    await edit(targetCharacter, "Собственная биография назначения", target.id, "10");
    const third = await character("Новый участник переноса");
    const beforeConflict = (await state(world.id, target.id)).history!.timeline.headRevision;
    const conflict = await transfer([first.id, third.id]);
    expect(conflict.status).toBe(409);
    const unchanged = await state(world.id, target.id, "10");
    expect(unchanged.characters.find((item) => item.id === first.id)?.biography).toBe("Собственная биография назначения");
    expect(unchanged.characters.some((item) => item.id === third.id)).toBe(false);
    expect(unchanged.history!.timeline.headRevision).toBe(beforeConflict);
    const comparison = await owner.call<{ differences: Difference[] }>("GET", `/timelines/${target.id}/compare?other=${main.id}&day=10`);
    expect(comparison.status).toBe(200);
    expect(comparison.data.differences.some((difference) => difference.id === first.id && difference.change === "changed")).toBe(true);
    expect((await transfer([first.id, third.id], { overwrite: true })).status).toBe(200);
    expect((await state(world.id, target.id, "10")).characters.find((item) => item.id === first.id)?.biography).toBe("Исходная биография");
    expect((await state(world.id, main.id, "10")).characters.find((item) => item.id === first.id)?.biography).toBe("Исходная биография");
    expect((await transfer([first.id], { overwrite: true, expectedRevision: beforeConflict })).status).toBe(409);
  });
});
