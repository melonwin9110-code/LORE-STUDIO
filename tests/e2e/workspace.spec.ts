import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { registerThroughApi, uniqueName } from "./helpers";
import type { Character, Project, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { FamilyData, TimelineGraph } from "../../src/lib/workspace-types";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin;
test.use({ actionTimeout: 15000 });

async function createWorld(page: Page, projectName: string, worldName: string) {
  const projectResponse = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name: projectName } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json() as { project: Project };
  const worldResponse = await page.request.post(`/api/projects/${project.id}/worlds`, { headers: { Origin: origin }, data: { name: worldName } });
  expect(worldResponse.status(), await worldResponse.text()).toBe(201);
  const { world } = await worldResponse.json() as { world: World };
  const loaded = await page.request.get(`/api/worlds/${world.id}`);
  expect(loaded.status()).toBe(200);
  const data = await loaded.json() as WorldData;
  return { project, world, main: data.history!.timeline };
}
async function setup(page: Page, worldName: string) {
  await registerThroughApi(page.request);
  return createWorld(page, uniqueName("Мастерская 0.3"), worldName);
}
async function seedCharacter(page: Page, worldId: string, name: string, birthYear = 0, biography = "Биография для проверки обновления") {
  const response = await page.request.post(`/api/worlds/${worldId}/characters`, { headers: { Origin: origin }, data: { name, birthYear, biography } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { character: Character }).character;
}
async function fork(page: Page, worldId: string, parentId: string, name: string) {
  const source = await page.request.get(`/api/worlds/${worldId}?timeline=${parentId}`);
  const head = (await source.json() as WorldData).history!.timeline.headRevision;
  const response = await page.request.post(`/api/worlds/${worldId}/timelines`, { headers: { Origin: origin }, data: { name, parentId, forkDay: "15", expectedParentRevision: head } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { timeline: Timeline }).timeline;
}
async function section(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Разделы мира" }).getByRole("button", { name, exact: true }).click();
}
async function changeLine(page: Page, id: string) {
  const select = page.getByRole("combobox", { name: "Временная линия", exact: true });
  if (await select.inputValue() !== id) {
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/worlds/") && new URL(response.url()).searchParams.get("timeline") === id && response.status() === 200),
      select.selectOption(id),
    ]);
  }
  await expect(select).toHaveValue(id);
}
async function openCharacter(page: Page, name: string) {
  await section(page, "Персонажи");
  await page.getByRole("button").filter({ has: page.getByRole("heading", { name, exact: true }) }).click();
  const dialog = page.getByRole("dialog", { name: "Карточка персонажа", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function removeProject(page: Page, id: string) {
  const result = await page.request.delete(`/api/projects/${id}`, { headers: { Origin: origin } });
  expect(result.ok(), await result.text()).toBe(true);
}

test("общее семейное древо доступно без даты, а групповое отношение сохраняет трёх участников", async ({ page }) => {
  test.setTimeout(120000);
  const { project, world, main } = await setup(page, "Семейный мир без выбора даты");
  const parent = await seedCharacter(page, world.id, "Терен Старший", 0);
  const child = await seedCharacter(page, world.id, "Лиора Младшая", 20);
  const sibling = await seedCharacter(page, world.id, "Мира Младшая", 25);
  const branch = await fork(page, world.id, main.id, "Альтернативная семейная история");
  const groupName = "Круг трёх хранителей";
  try {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Временная линия", exact: true })).toHaveValue(main.id, { timeout: 15000 });
    await section(page, "Семейное древо");
    await expect(page.getByRole("heading", { name: "Семейное древо", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Добавить родственную связь", exact: true })).toBeEnabled();
    for (const name of [child.name, sibling.name]) {
      await page.getByRole("button", { name: "Добавить родственную связь", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Новая родственная связь", exact: true });
      await dialog.getByRole("combobox", { name: "От персонажа", exact: true }).selectOption(parent.id);
      await dialog.getByRole("combobox", { name: "К персонажу", exact: true }).selectOption({ label: name });
      await dialog.getByRole("combobox", { name: "Семейная связь", exact: true }).selectOption("parent");
      await dialog.getByRole("button", { name: "Сохранить родство", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    const childFamily = page.getByRole("article").filter({ has: page.getByRole("heading", { name: child.name, exact: true }) });
    await expect(childFamily.getByText(sibling.name, { exact: true })).toBeVisible();
    await section(page, "Обзор мира");
    await changeLine(page, branch.id);
    await section(page, "Семейное древо");
    await expect(childFamily.getByText(sibling.name, { exact: true })).toBeVisible();
    await page.reload();
    await section(page, "Семейное древо");
    await expect(childFamily.getByText(sibling.name, { exact: true })).toBeVisible();
    await section(page, "Обзор мира");
    await changeLine(page, main.id);
    await section(page, "Семейное древо");
    await expect(childFamily.getByText(parent.name, { exact: true })).toBeVisible();

    await section(page, "Отношения");
    await page.getByRole("button", { name: "Добавить отношение", exact: true }).click();
    const group = page.getByRole("dialog", { name: "Новое отношение", exact: true });
    await group.getByRole("checkbox", { name: "Групповое отношение", exact: true }).check();
    for (const name of [parent.name, child.name, sibling.name]) await group.getByRole("checkbox", { name, exact: true }).check();
    await group.getByRole("combobox", { name: "Тип отношения", exact: true }).fill(groupName);
    await group.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(group).toHaveCount(0);
    await page.reload();
    await section(page, "Отношения");
    const relationButton = page.getByRole("button").filter({ has: page.getByText(groupName, { exact: true }) });
    await expect(relationButton).toBeVisible();
    for (const name of [parent.name, child.name, sibling.name]) await expect(relationButton).toContainText(name);
    const loaded = await page.request.get(`/api/worlds/${world.id}?timeline=${main.id}`);
    const relation = (await loaded.json() as WorldData).relations.find((value) => value.kind === groupName)!;
    expect(new Set(relation.participantIds)).toEqual(new Set([parent.id, child.id, sibling.id]));
    const sharedFamily = await page.request.get(`/api/worlds/${world.id}/family`);
    expect((await sharedFamily.json() as FamilyData).relations).toHaveLength(2);

    await section(page, "Семейное древо");
    const familyRelation = page.getByRole("region", { name: "Родственные связи", exact: true }).getByRole("button").filter({ hasText: child.name });
    await familyRelation.click();
    const familyEditor = page.getByRole("dialog", { name: "Родственная связь", exact: true });
    await familyEditor.getByRole("textbox", { name: "Описание родства", exact: true }).fill("Семейная запись сохраняется независимо от истории");
    await familyEditor.getByRole("button", { name: "Сохранить родство", exact: true }).click();
    await expect(familyEditor).toHaveCount(0);
    await page.reload();
    await section(page, "Семейное древо");
    await familyRelation.click();
    await expect(familyEditor.getByRole("textbox", { name: "Описание родства", exact: true })).toHaveValue("Семейная запись сохраняется независимо от истории");
    page.once("dialog", (dialog) => dialog.accept());
    await familyEditor.getByRole("button", { name: "Удалить родство", exact: true }).click();
    await expect(familyEditor).toHaveCount(0);
    await expect(familyRelation).toHaveCount(0);
    expect((await (await page.request.get(`/api/worlds/${world.id}/family`)).json() as FamilyData).relations).toHaveLength(1);
  } finally { await removeProject(page, project.id); }
});

test("свой портрет сохраняется и общий каталог открывает персонажа в правильном источнике", async ({ page }) => {
  test.setTimeout(120000);
  const first = await setup(page, "Северный мир портретов");
  const name = "Лиора с собственным портретом";
  const hero = await seedCharacter(page, first.world.id, name, 20, "Биография северной Лиоры");
  const second = await createWorld(page, uniqueName("Другой проект каталога"), "Южный мир одноимённых героев");
  await seedCharacter(page, second.world.id, name, 30, "Биография южной Лиоры");
  const png = await sharp({ create: { width: 48, height: 64, channels: 3, background: { r: 140, g: 72, b: 192 } } }).png().toBuffer();
  try {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Текущий проект", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Текущий проект", exact: true }).selectOption(first.project.id);
    await expect(page.getByRole("heading", { name: first.world.name, exact: true })).toBeVisible();
    const dialog = await openCharacter(page, name);
    await dialog.getByLabel("Изображение персонажа", { exact: true }).setInputFiles({ name: "lora-own.png", mimeType: "image/png", buffer: png });
    await dialog.getByRole("button", { name: "Сохранить портрет", exact: true }).click();
    const image = dialog.getByRole("img", { name: `Портрет ${name}`, exact: true });
    await expect(image).toHaveAttribute("src", new RegExp(`/api/characters/${hero.id}/portrait`));
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Все персонажи — общий каталог", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Все персонажи", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Поиск по всем персонажам", exact: true }).fill(name);
    await page.getByRole("button", { name: "Найти", exact: true }).click();
    const source = page.getByRole("button", { name: `Открыть ${name} — ${first.world.name} — ${first.main.name}`, exact: true });
    const otherSource = page.getByRole("button", { name: `Открыть ${name} — ${second.world.name} — ${second.main.name}`, exact: true });
    await expect(source).toBeVisible(); await expect(otherSource).toBeVisible();
    await expect(source).toContainText(first.project.name); await expect(source).toContainText(first.world.name); await expect(source).toContainText(first.main.name);
    await expect(source.getByRole("img", { name: `Портрет ${name}`, exact: true })).toHaveAttribute("src", new RegExp(`/api/characters/${hero.id}/portrait`));
    await page.getByRole("combobox", { name: "Проект каталога", exact: true }).selectOption(second.project.id);
    await expect(source).toHaveCount(0); await expect(otherSource).toBeVisible();
    await page.getByRole("combobox", { name: "Проект каталога", exact: true }).selectOption(first.project.id);
    await expect(source).toBeVisible(); await expect(otherSource).toHaveCount(0);
    await source.click();
    await expect(page.getByRole("combobox", { name: "Текущий проект", exact: true })).toHaveValue(first.project.id);
    await expect(page.getByRole("combobox", { name: "Временная линия", exact: true })).toHaveValue(first.main.id);
    const opened = page.getByRole("dialog", { name: "Карточка персонажа", exact: true });
    await expect(opened).toBeVisible();
    await expect(opened.getByRole("img", { name: `Портрет ${name}`, exact: true })).toHaveAttribute("src", new RegExp(`/api/characters/${hero.id}/portrait`));
    await opened.getByRole("tab", { name: "История и характер", exact: true }).click();
    await expect(opened.getByRole("textbox", { name: "Биография", exact: true })).toHaveValue("Биография северной Лиоры");
    await opened.getByRole("tab", { name: "Основное", exact: true }).click();
    await opened.getByRole("button", { name: "Удалить портрет", exact: true }).click();
    await expect(opened.getByRole("img", { name: `Портрет ${name}`, exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/characters/${hero.id}/portrait`)).status()).toBe(404);
  } finally { await removeProject(page, first.project.id); await removeProject(page, second.project.id); }
});

test("редактор линий сохраняет ручное перемещение, переплетение и новую линию без изменения родителя", async ({ page }) => {
  test.setTimeout(120000);
  const { project, world, main } = await setup(page, "Мир визуальных историй");
  await seedCharacter(page, world.id, "Хранитель схемы");
  const branch = await fork(page, world.id, main.id, "Серебряная ветвь редактора");
  const linkName = "Переплетение у двух лун";
  try {
    await page.goto("/");
    await section(page, "Редактор линий");
    await expect(page.getByRole("heading", { name: "Редактор временных линий", exact: true })).toBeVisible();
    const node = page.getByTestId(`timeline-node-${main.id}`);
    await expect(node).toBeVisible();
    await node.scrollIntoViewIfNeeded();
    await expect(node).toBeInViewport();
    const box = await node.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 90, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(box!.x + 150, box!.y + 110, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Сохранить схему", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Сохранить схему", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Схема");
    const graphResponse = await page.request.get(`/api/worlds/${world.id}/timeline-graph`);
    const firstSaved = await graphResponse.json() as TimelineGraph;
    expect(firstSaved.positions[main.id]).toBeDefined();
    expect(Math.abs(firstSaved.positions[main.id].x - 40) + Math.abs(firstSaved.positions[main.id].y - 50)).toBeGreaterThan(20);

    await page.getByTestId(`timeline-source-${main.id}`).scrollIntoViewIfNeeded();
    await expect(page.getByTestId(`timeline-target-${branch.id}`)).toBeInViewport();
    const source = await page.getByTestId(`timeline-source-${main.id}`).boundingBox();
    const target = await page.getByTestId(`timeline-target-${branch.id}`).boundingBox();
    expect(source).not.toBeNull(); expect(target).not.toBeNull();
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 15 });
    await page.mouse.up();
    const connection = page.getByRole("dialog", { name: "Переплетение историй", exact: true });
    await expect(connection).toBeVisible();
    await connection.getByRole("combobox", { name: "Линия-источник", exact: true }).selectOption(main.id);
    await connection.getByRole("combobox", { name: "Линия-цель", exact: true }).selectOption(branch.id);
    await connection.getByRole("combobox", { name: "Тип переплетения", exact: true }).selectOption("travel");
    await connection.getByRole("textbox", { name: "Название переплетения", exact: true }).fill(linkName);
    await connection.getByRole("button", { name: "Добавить связь", exact: true }).click();
    await expect(connection).toHaveCount(0);
    await page.getByRole("button", { name: "Сохранить схему", exact: true }).click();
    await expect(page.getByRole("button", { name: `Изменить переплетение ${linkName}`, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Добавить линию", exact: true }).click();
    const create = page.getByRole("dialog", { name: "Новая временная линия", exact: true });
    await create.getByRole("textbox", { name: "Название линии", exact: true }).fill("Третья независимая история");
    await create.getByRole("combobox", { name: "Тип линии", exact: true }).selectOption("independent");
    await create.getByRole("button", { name: "Создать линию", exact: true }).click();
    await expect(create).toHaveCount(0);
    const newLine = (await (await page.request.get(`/api/worlds/${world.id}`)).json() as WorldData).history!.timelines.find((value) => value.name === "Третья независимая история")!;
    expect(newLine).toBeDefined();
    await expect(page.getByTestId(`timeline-node-${newLine.id}`)).toBeVisible();
    await page.getByRole("button", { name: "Сохранить схему", exact: true }).click();
    const beforeReload = await (await page.request.get(`/api/worlds/${world.id}/timeline-graph`)).json() as TimelineGraph;
    expect(beforeReload.connections).toHaveLength(1);
    expect(beforeReload.connections[0]).toMatchObject({ sourceId: main.id, targetId: branch.id, label: linkName, kind: "travel" });
    await page.reload();
    await section(page, "Редактор линий");
    await expect(page.getByRole("button", { name: `Изменить переплетение ${linkName}`, exact: true })).toBeVisible();
    const afterReload = await (await page.request.get(`/api/worlds/${world.id}/timeline-graph`)).json() as TimelineGraph;
    expect(afterReload.positions[main.id]).toEqual(beforeReload.positions[main.id]);
    const ancestry = (await (await page.request.get(`/api/worlds/${world.id}`)).json() as WorldData).history!.timelines.find((line) => line.id === branch.id)!;
    expect(ancestry.parentId).toBe(main.id); expect(ancestry.parentRevision).toBe(branch.parentRevision); expect(ancestry.forkDay).toBe(branch.forkDay);
    await page.getByRole("button", { name: `Изменить переплетение ${linkName}`, exact: true }).click();
    await page.getByRole("dialog", { name: "Переплетение историй", exact: true }).getByRole("button", { name: "Удалить переплетение", exact: true }).click();
    await page.getByRole("button", { name: "Сохранить схему", exact: true }).click();
    expect((await (await page.request.get(`/api/worlds/${world.id}/timeline-graph`)).json() as TimelineGraph).connections).toHaveLength(0);
  } finally { await removeProject(page, project.id); }
});
