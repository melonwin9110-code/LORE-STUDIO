import { test, expect, type Page, type Locator } from "@playwright/test";
import sharp from "sharp";
import { registerThroughApi, uniqueName } from "./helpers";
import type { Project, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { MapData, MapFeatureInput, MapGeometry, MapPoint } from "../../src/lib/map-types";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin;
test.use({ actionTimeout: 15000, viewport: { width: 1440, height: 1000 } });
const rectangle = (x: number, y: number, width: number, height: number): MapGeometry => ({ type: "Polygon", coordinates: [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]] });
const input = (layerId: string, extra: Partial<MapFeatureInput> = {}): MapFeatureInput => ({ name: "Территория для проверки", kind: "state", layerId, geometry: rectangle(200, 200, 400, 300), description: "", fill: "#ef6677", stroke: "#ef6677", strokeWidth: 1.5, label: false, eventId: null, parentId: null, ...extra });
async function setup(page: Page) {
  await registerThroughApi(page.request);
  const projectResponse = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name: uniqueName("Географическая мастерская") } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json() as { project: Project };
  const worldResponse = await page.request.post(`/api/projects/${project.id}/worlds`, { headers: { Origin: origin }, data: { name: "Мир настоящего атласа" } });
  expect(worldResponse.status(), await worldResponse.text()).toBe(201);
  const { world } = await worldResponse.json() as { world: World };
  const loaded = await page.request.get(`/api/worlds/${world.id}`);
  const main = (await loaded.json() as WorldData).history!.timeline;
  return { project, world, main };
}
async function removeProject(page: Page, id: string) {
  const result = await page.request.delete(`/api/projects/${id}`, { headers: { Origin: origin } });
  expect(result.ok(), await result.text()).toBe(true);
}
async function openAtlas(page: Page) {
  await page.getByRole("navigation", { name: "Разделы мира", exact: true }).getByRole("button", { name: "Атлас мира", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^Атлас мира/ })).toBeVisible();
}
async function canvas(page: Page) {
  const target = page.getByTestId("map-canvas");
  await expect(target).toHaveAttribute("data-ready", "true", { timeout: 20000 });
  await target.scrollIntoViewIfNeeded();
  return target;
}
async function screenPoint(target: Locator, point: MapPoint, width = 1000, height = 700) {
  const box = await target.boundingBox(); expect(box).not.toBeNull();
  const resolution = Math.max(width / (box!.width - 64), height / (box!.height - 84));
  return { x: box!.x + box!.width / 2 + (point[0] - width / 2) / resolution, y: box!.y + box!.height / 2 - (point[1] - height / 2) / resolution };
}
async function fitCanvas(page: Page) {
  const target = await canvas(page);
  await page.getByRole("button", { name: "Уместить карту", exact: true }).click();
  const box = (await target.boundingBox())!;
  const resolution = Math.max(1000 / (box.width - 64), 700 / (box.height - 84));
  let attempt = 0;
  // The inspector resizes the viewport while OpenLayers correctly keeps the
  // author's zoom. Explicitly fit before gestures at known world coordinates,
  // and wait for the visible coordinate readout instead of a fixed delay.
  await expect.poll(async () => {
    const offset = 80 + (attempt++ % 2) * 0.1;
    await page.mouse.move(box.x + box.width / 2 + offset, box.y + box.height / 2);
    const values = (await target.locator("..").locator('[class*="coordinates"] > span').innerText()).match(/\d+/g)?.map(Number);
    return Boolean(values && Math.abs(values[0] - (500 + offset * resolution)) <= 1 && Math.abs(values[1] - 350) <= 1);
  }).toBe(true);
  return target;
}
async function draw(page: Page, kind: string, points: MapPoint[]) {
  await page.getByRole("combobox", { name: "Тип объекта карты", exact: true }).selectOption(kind);
  await page.getByRole("button", { name: "Нарисовать объект", exact: true }).click();
  const target = await fitCanvas(page);
  for (let index = 0; index < points.length; index++) {
    const pixel = await screenPoint(target, points[index]);
    if (index === points.length - 1 && points.length > 1) await page.mouse.dblclick(pixel.x, pixel.y);
    else await page.mouse.click(pixel.x, pixel.y);
  }
}
async function renameSelected(page: Page, name: string, description?: string) {
  await page.getByRole("textbox", { name: "Название объекта", exact: true }).fill(name);
  if (description !== undefined) { await showDescription(page); await page.getByRole("textbox", { name: "Описание объекта карты", exact: true }).fill(description); }
  await page.getByRole("button", { name: "Применить свойства", exact: true }).click();
  await expect(page.getByRole("button", { name: `Выбрать объект ${name}`, exact: true })).toBeVisible();
}
async function showDescription(page: Page) {
  const summary = page.getByText("Описание и связи", { exact: true });
  if (await summary.count() && !(await summary.evaluate((element) => element.closest("details")?.open))) await summary.click();
}
async function showExtraTools(page: Page) {
  const summary = page.getByText("Ещё", { exact: true });
  if (await summary.count() && !(await summary.evaluate((element) => element.closest("details")?.open))) await summary.click();
}
async function save(page: Page) {
  const button = page.getByRole("button", { name: "Сохранить карту", exact: true });
  await expect(button).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse((result) => result.request().method() === "PUT" && /\/api\/maps\/[^/]+\/content/.test(new URL(result.url()).pathname)),
    button.click(),
  ]);
  expect(response.status(), await response.text()).toBe(200);
  await expect(button).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
}
async function getMap(page: Page, id: string, timeline?: string, day?: string) {
  const query = new URLSearchParams({ ...(timeline ? { timeline } : {}), ...(day ? { day } : {}) });
  const result = await page.request.get(`/api/maps/${id}${query.size ? `?${query}` : ""}`);
  expect(result.status(), await result.text()).toBe(200);
  return result.json() as Promise<MapData>;
}
async function seedMap(page: Page, worldId: string, timeline: string, definitions: (layers: MapData["layers"]) => { id: string; data: MapFeatureInput }[]) {
  const created = await page.request.post(`/api/worlds/${worldId}/maps?timeline=${timeline}&day=10`, { headers: { Origin: origin }, data: { name: "Исторический атлас", description: "", width: 1000, height: 700, background: "#142936" } });
  expect(created.status(), await created.text()).toBe(201);
  const data = await created.json() as MapData;
  const stored = await page.request.put(`/api/maps/${data.map.id}/content?timeline=${timeline}&day=10`, { headers: { Origin: origin }, data: { expectedRevision: data.revision, layers: [], features: definitions(data.layers).map((value) => ({ op: "create", ...value })) } });
  expect(stored.status(), await stored.text()).toBe(200);
  return stored.json() as Promise<MapData>;
}
async function changeLine(page: Page, id: string) {
  const select = page.getByRole("combobox", { name: "Временная линия", exact: true });
  if (!await select.isVisible()) await page.getByText("Линия и время карты", { exact: true }).click();
  await select.selectOption(id); await expect(select).toHaveValue(id);
  await canvas(page);
}
async function canvasPixel(page: Page, coordinate: MapPoint) {
  const target = await canvas(page), box = await target.boundingBox(), pixel = await screenPoint(target, coordinate);
  const { data, info } = await sharp(await target.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = Math.round(pixel.x - box!.x), y = Math.round(pixel.y - box!.y), offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

test("автор рисует настоящие территории, города и реку, отменяет черновик и сохраняет атлас после перезагрузки", async ({ page }) => {
  test.setTimeout(150000);
  const { project } = await setup(page);
  try {
    await page.goto("/"); await openAtlas(page);
    await page.getByRole("button", { name: "Новая карта", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Новая карта", exact: true });
    await dialog.getByRole("textbox", { name: "Название карты", exact: true }).fill("Земли двух лун");
    await dialog.getByRole("button", { name: "Создать карту", exact: true }).click();
    await expect(dialog).toHaveCount(0); await canvas(page);
    const id = await page.getByRole("combobox", { name: "Карта мира", exact: true }).inputValue();
    await draw(page, "continent", [[160, 180], [630, 180], [630, 530], [160, 530]]);
    await renameSelected(page, "Материк Рассвета", "Контур нарисован мышью и должен сохраниться");
    await draw(page, "city", [[730, 520]]); await renameSelected(page, "Порт двух лун");
    await draw(page, "river", [[360, 130], [420, 330], [550, 480]]);
    await expect(page.getByRole("button", { name: "Выбрать объект Река 1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await expect(page.getByRole("button", { name: "Выбрать объект Река 1", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Повторить действие", exact: true }).click();
    await page.getByRole("button", { name: "Выбрать объект Река 1", exact: true }).click();
    await renameSelected(page, "Серебряная река");
    page.once("dialog", (confirmation) => confirmation.dismiss());
    await page.getByRole("navigation", { name: "Разделы мира", exact: true }).getByRole("button", { name: "Обзор мира", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^Атлас мира/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Выбрать объект Серебряная река", exact: true })).toBeVisible();
    await save(page);
    const stored = await getMap(page, id);
    expect(new Set(stored.features.map((value) => value.kind))).toEqual(new Set(["continent", "city", "river"]));
    expect(stored.features.find((value) => value.name === "Материк Рассвета")).toMatchObject({ description: "Контур нарисован мышью и должен сохраниться", geometry: { type: "Polygon" } });
    expect(stored.features.find((value) => value.name === "Порт двух лун")?.geometry.type).toBe("Point");
    expect(stored.features.find((value) => value.name === "Серебряная река")?.geometry.type).toBe("LineString");
    await page.reload(); await openAtlas(page); await canvas(page);
    await page.getByRole("button", { name: "Выбрать объект Материк Рассвета", exact: true }).click();
    await showDescription(page);
    await expect(page.getByRole("textbox", { name: "Описание объекта карты", exact: true })).toHaveValue("Контур нарисован мышью и должен сохраниться");
    await page.getByRole("button", { name: "История объекта", exact: true }).click();
    const history = page.getByRole("dialog", { name: "История объекта карты", exact: true });
    await expect(history.getByText("Состояние 1", { exact: true })).toBeVisible();
    await history.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("button", { name: "Настройки карты", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Настройки карты", exact: true });
    await settings.getByRole("textbox", { name: "Название карты", exact: true }).fill("Земли двух лун — сохранённая редакция");
    await settings.getByRole("button", { name: "Сохранить настройки карты", exact: true }).click();
    await expect(settings).toHaveCount(0);
    expect((await getMap(page, id)).map.name).toBe("Земли двух лун — сохранённая редакция");
  } finally { await removeProject(page, project.id); }
});

test("физическая и политическая карты используют общую основу, а движение и узлы границы меняются только в ветке", async ({ page }) => {
  test.setTimeout(150000);
  const { project, world, main } = await setup(page);
  const seeded = await seedMap(page, world.id, main.id, (layers) => [
    { id: crypto.randomUUID(), data: input(layers.find((layer) => layer.kind === "physical")!.id, { kind: "continent", name: "Общая физическая земля", geometry: rectangle(100, 100, 700, 500), fill: "#447755", stroke: "#447755" }) },
    { id: crypto.randomUUID(), data: input(layers.find((layer) => layer.kind === "political")!.id, { name: "Границы империи" }) },
  ]);
  const loaded = await page.request.get(`/api/worlds/${world.id}`), head = (await loaded.json() as WorldData).history!.timeline.headRevision;
  const branchResponse = await page.request.post(`/api/worlds/${world.id}/timelines`, { headers: { Origin: origin }, data: { name: "Линия иных границ", parentId: main.id, forkDay: "15", expectedParentRevision: head } });
  expect(branchResponse.status(), await branchResponse.text()).toBe(201);
  const branch = (await branchResponse.json() as { timeline: Timeline }).timeline;
  try {
    await page.goto("/"); await openAtlas(page); await canvas(page);
    await expect(page.getByRole("button", { name: "Физическая карта", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => canvasPixel(page, [250, 250])).toEqual([68, 119, 85]);
    await page.getByRole("button", { name: "Политическая карта", exact: true }).click();
    await expect.poll(() => canvasPixel(page, [250, 250])).toEqual([239, 102, 119]);
    await changeLine(page, branch.id);
    await page.getByRole("button", { name: "Выбрать объект Границы империи", exact: true }).click();
    await page.getByRole("button", { name: "Переместить объекты", exact: true }).click();
    let target = await fitCanvas(page), start = await screenPoint(target, [300, 250]), end = await screenPoint(target, [430, 300]);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 16 }); await page.mouse.up();
    await save(page);
    const moved = await getMap(page, seeded.map.id, branch.id), territory = moved.features.find((value) => value.kind === "state")!;
    expect(territory.geometry).not.toEqual(seeded.features.find((value) => value.kind === "state")!.geometry);
    expect((await getMap(page, seeded.map.id, main.id)).features.find((value) => value.kind === "state")!.geometry).toEqual(seeded.features.find((value) => value.kind === "state")!.geometry);
    expect(territory.geometry.type).toBe("Polygon");
    const vertex = (territory.geometry as Extract<MapGeometry, { type: "Polygon" }>).coordinates[0][0];
    await page.getByRole("button", { name: "Выбрать объект Границы империи", exact: true }).click();
    await page.getByRole("button", { name: "Редактировать узлы", exact: true }).click();
    target = await fitCanvas(page); start = await screenPoint(target, vertex); end = await screenPoint(target, [vertex[0] + 25, vertex[1] + 30]);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
    await expect(page.getByRole("button", { name: "Сохранить карту", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await expect(page.getByRole("button", { name: "Сохранить карту", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Повторить действие", exact: true }).click();
    await save(page);
    const modified = await getMap(page, seeded.map.id, branch.id);
    expect(modified.features.find((value) => value.kind === "state")!.geometry).not.toEqual(territory.geometry);
    const political = modified.layers.find((layer) => layer.kind === "political")!;
    await page.getByRole("checkbox", { name: `Показать слой ${political.name}`, exact: true }).uncheck();
    await save(page); await page.reload(); await openAtlas(page); await canvas(page);
    await expect(page.getByRole("checkbox", { name: `Показать слой ${political.name}`, exact: true })).not.toBeChecked();
    expect((await getMap(page, seeded.map.id, main.id)).layers.find((layer) => layer.id === political.id)!.visible).toBe(true);
    const baseFeature = seeded.features.find((value) => value.kind === "continent")!;
    expect((await getMap(page, seeded.map.id, branch.id)).features.find((value) => value.id === baseFeature.id)!.geometry).toEqual(baseFeature.geometry);
  } finally { await removeProject(page, project.id); }
});

test("объединение и разделение территорий отменяются в черновике, а слои и мобильные правки сохраняются", async ({ page }) => {
  test.setTimeout(150000);
  const { project, world, main } = await setup(page);
  const seeded = await seedMap(page, world.id, main.id, (layers) => [
    { id: crypto.randomUUID(), data: input(layers.find((layer) => layer.kind === "political")!.id, { name: "Западная территория", geometry: rectangle(150, 200, 200, 250) }) },
    { id: crypto.randomUUID(), data: input(layers.find((layer) => layer.kind === "political")!.id, { name: "Восточная территория", geometry: rectangle(350, 200, 200, 250) }) },
  ]);
  try {
    await page.goto("/"); await openAtlas(page); await canvas(page);
    await page.getByRole("button", { name: "Политическая карта", exact: true }).click();
    for (const name of ["Западная территория", "Восточная территория"]) await page.getByRole("checkbox", { name: `Выделить объект ${name}`, exact: true }).check();
    await showExtraTools(page);
    await page.getByRole("button", { name: "Объединить территории", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Выбрать объект (Западная|Восточная) территория$/ })).toHaveCount(1);
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Выбрать объект (Западная|Восточная) территория$/ })).toHaveCount(2);
    await page.getByRole("button", { name: "Повторить действие", exact: true }).click();
    await save(page);
    const united = await getMap(page, seeded.map.id); expect(united.features).toHaveLength(1);
    await page.getByRole("button", { name: `Выбрать объект ${united.features[0].name}`, exact: true }).click();
    await showExtraTools(page);
    await page.getByRole("button", { name: "Разделить территорию", exact: true }).click();
    const target = await fitCanvas(page), start = await screenPoint(target, [350, 120]), end = await screenPoint(target, [350, 550]);
    await page.mouse.click(start.x, start.y); await page.mouse.dblclick(end.x, end.y);
    await expect(page.getByRole("button", { name: new RegExp(`^Выбрать объект ${united.features[0].name} · часть 2$`) })).toBeVisible();
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await expect(page.getByRole("button", { name: / · часть 2$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Повторить действие", exact: true }).click();
    await save(page); expect((await getMap(page, seeded.map.id)).features).toHaveLength(2);
    await page.getByRole("button", { name: "Добавить слой", exact: true }).click();
    const layer = page.getByRole("dialog", { name: "Новый слой", exact: true });
    await layer.getByRole("textbox", { name: "Название слоя", exact: true }).fill("Пути караванов");
    await layer.getByRole("spinbutton", { name: "Непрозрачность слоя", exact: true }).fill("0.6");
    await layer.getByRole("button", { name: "Добавить слой", exact: true }).click();
    await save(page); await page.reload(); await openAtlas(page); await canvas(page);
    await expect(page.getByRole("button", { name: "Работать со слоем Пути караванов", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const survivor = (await getMap(page, seeded.map.id)).features[0];
    await page.getByRole("button", { name: `Выбрать объект ${survivor.name}`, exact: true }).click();
    await renameSelected(page, "Мобильная провинция", "Правка с узкого экрана");
    await save(page);
    expect((await getMap(page, seeded.map.id)).features.find((value) => value.id === survivor.id)?.description).toBe("Правка с узкого экрана");
    await page.getByRole("button", { name: "Настройки слоя Пути караванов", exact: true }).click();
    const layerSettings = page.getByRole("dialog", { name: "Настройки слоя", exact: true });
    await layerSettings.getByRole("button", { name: "Удалить слой", exact: true }).click(); await save(page);
    expect((await getMap(page, seeded.map.id)).layers.some((value) => value.name === "Пути караванов")).toBe(false);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Удалить карту", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Карта мира", exact: true })).toHaveCount(0);
    expect((await page.request.get(`/api/maps/${seeded.map.id}`)).status()).toBe(404);
  } finally { await removeProject(page, project.id); }
});
