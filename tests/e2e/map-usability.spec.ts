import { test, expect, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { registerThroughApi, uniqueName } from "./helpers";
import type { Project, World, WorldData } from "../../src/lib/types";
import type { MapData, MapFeatureInput, MapGeometry, MapPoint } from "../../src/lib/map-types";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin;
test.use({ actionTimeout: 15000, viewport: { width: 1540, height: 1050 } });
const rectangle = (x: number, y: number, width: number, height: number): MapGeometry => ({ type: "Polygon", coordinates: [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]] });
const feature = (layerId: string, extra: Partial<MapFeatureInput> = {}): MapFeatureInput => ({ name: "Сосновый лес", kind: "forest", layerId, geometry: rectangle(200, 200, 400, 300), description: "", fill: "#779966", stroke: "#aa3344", strokeWidth: 2, label: false, eventId: null, parentId: null, ...extra });

async function setup(page: Page) {
  await registerThroughApi(page.request);
  const projectResponse = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name: uniqueName("Простая картография") } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const { project } = await projectResponse.json() as { project: Project };
  const worldResponse = await page.request.post(`/api/projects/${project.id}/worlds`, { headers: { Origin: origin }, data: { name: "Мир удобной карты" } });
  expect(worldResponse.status(), await worldResponse.text()).toBe(201);
  const { world } = await worldResponse.json() as { world: World };
  const loaded = await page.request.get(`/api/worlds/${world.id}`);
  const main = (await loaded.json() as WorldData).history!.timeline;
  return { project, world, main };
}
async function cleanup(page: Page, projectId: string) {
  const result = await page.request.delete(`/api/projects/${projectId}`, { headers: { Origin: origin } });
  expect(result.status(), await result.text()).toBe(200);
}
async function openAtlas(page: Page) {
  await page.getByRole("navigation", { name: "Разделы мира", exact: true }).getByRole("button", { name: "Атлас мира", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Атлас мира", exact: true })).toBeVisible();
}
async function canvas(page: Page) {
  const target = page.getByTestId("map-canvas");
  await expect(target).toHaveAttribute("data-ready", "true", { timeout: 20000 });
  await target.scrollIntoViewIfNeeded();
  return target;
}
async function pixelPosition(target: Locator, point: MapPoint) {
  const box = await target.boundingBox(); expect(box).not.toBeNull();
  const resolution = Math.max(1000 / (box!.width - 64), 700 / (box!.height - 84));
  return { x: box!.width / 2 + (point[0] - 500) / resolution, y: box!.height / 2 - (point[1] - 350) / resolution };
}
async function canvasPixels(page: Page, point: MapPoint, halfWidth = 0) {
  const target = await canvas(page), pixel = await pixelPosition(target, point);
  const { data, info } = await sharp(await target.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Array.from({ length: halfWidth * 2 + 1 }, (_, index) => {
    const x = Math.round(pixel.x) + index - halfWidth, y = Math.round(pixel.y), offset = (y * info.width + x) * info.channels;
    return [data[offset], data[offset + 1], data[offset + 2]];
  });
}
async function pixel(page: Page, point: MapPoint) { return (await canvasPixels(page, point))[0]; }
async function redContourPixels(page: Page) {
  return (await canvasPixels(page, [200, 280], 12)).filter(([red, green, blue]) => red > 220 && green < 80 && blue < 90).length;
}
async function setColor(input: Locator, value: string) {
  // Drive the native color control's events without depending on an OS picker.
  await input.evaluate((element, color) => {
    const field = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, color);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(input).toHaveValue(value);
}
async function setRange(input: Locator, value: string) {
  await input.evaluate((element, current) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, current);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(input).toHaveValue(value);
}
async function save(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse((value) => value.request().method() === "PUT" && /\/api\/maps\/[^/]+\/content/.test(new URL(value.url()).pathname)),
    page.getByRole("button", { name: "Сохранить карту", exact: true }).click(),
  ]);
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole("button", { name: "Сохранить карту", exact: true })).toBeDisabled();
}
async function mapState(page: Page, id: string) {
  const response = await page.request.get(`/api/maps/${id}`); expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<MapData>;
}
async function seed(page: Page, worldId: string, withOverlappingLayer = false) {
  const response = await page.request.post(`/api/worlds/${worldId}/maps`, { headers: { Origin: origin }, data: { name: "Атлас живого оформления", width: 1000, height: 700, background: "#142936" } });
  expect(response.status(), await response.text()).toBe(201);
  const data = await response.json() as MapData, physical = data.layers.find((layer) => layer.kind === "physical")!, political = data.layers.find((layer) => layer.kind === "political")!;
  const layerId = crypto.randomUUID(), targetId = crypto.randomUUID();
  const stored = await page.request.put(`/api/maps/${data.map.id}/content`, { headers: { Origin: origin }, data: {
    expectedRevision: data.revision,
    layers: withOverlappingLayer ? [{ op: "create", id: layerId, data: { name: "Краски поверх", kind: "custom", visible: true, locked: false, opacity: 1, order: 10 } }] : [],
    features: [
      { op: "create", id: crypto.randomUUID(), data: feature(physical.id, { name: "Материк основы", kind: "continent", geometry: rectangle(50, 50, 900, 600), fill: "#335577", stroke: "#335577" }) },
      { op: "create", id: targetId, data: feature(withOverlappingLayer ? layerId : physical.id) },
      ...(withOverlappingLayer ? [{ op: "create", id: crypto.randomUUID(), data: feature(political.id, { name: "Область политики", kind: "state", geometry: rectangle(700, 400, 150, 150), fill: "#cc8844", stroke: "#cc8844" }) }] : []),
    ],
  } });
  expect(stored.status(), await stored.text()).toBe(200);
  return { data: await stored.json() as MapData, targetId, layerId, physical, political };
}

test("заливка и контур меняются сразу на выделенном объекте, а отмена и сохранение удерживают настоящее оформление", async ({ page }) => {
  test.setTimeout(150000);
  const { project, world } = await setup(page);
  const seeded = await seed(page, world.id);
  try {
    await page.goto("/"); await openAtlas(page); await canvas(page);
    await page.getByRole("button", { name: "Выбрать объект Сосновый лес", exact: true }).click();
    const objectName = page.getByRole("textbox", { name: "Название объекта", exact: true });
    await objectName.fill("Лес после переименования");
    await objectName.blur();
    await expect(page.getByRole("button", { name: "Выбрать объект Лес после переименования", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await page.getByRole("button", { name: "Выбрать объект Сосновый лес", exact: true }).click();
    await expect(objectName).toHaveValue("Сосновый лес");
    await page.getByRole("button", { name: "Повторить действие", exact: true }).click();
    await page.getByRole("button", { name: "Выбрать объект Лес после переименования", exact: true }).click();
    await expect(objectName).toHaveValue("Лес после переименования");
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await page.getByRole("button", { name: "Выбрать объект Сосновый лес", exact: true }).click();
    await expect(objectName).toHaveValue("Сосновый лес");
    await setColor(page.getByLabel("Заливка объекта", { exact: true }), "#22cc66");
    await expect.poll(() => pixel(page, [400, 350])).toEqual([34, 204, 102]);
    await setColor(page.getByLabel("Контур объекта", { exact: true }), "#ee3344");
    await expect.poll(() => redContourPixels(page)).toBeGreaterThanOrEqual(1);
    const narrow = await redContourPixels(page);
    await page.getByRole("spinbutton", { name: "Толщина контура", exact: true }).fill("8");
    await expect.poll(() => redContourPixels(page)).toBeGreaterThanOrEqual(narrow + 4);
    await expect(page.getByLabel("Заливка объекта", { exact: true })).toHaveValue("#22cc66");
    await page.getByRole("button", { name: "Отменить действие", exact: true }).click();
    await expect.poll(() => redContourPixels(page)).toBeLessThan(narrow + 4);
    await page.getByRole("button", { name: "Повторить действие", exact: true }).click();
    await expect.poll(() => redContourPixels(page)).toBeGreaterThanOrEqual(narrow + 4);
    await save(page);
    const stored = (await mapState(page, seeded.data.map.id)).features.find((value) => value.id === seeded.targetId)!;
    expect(stored).toMatchObject({ fill: "#22cc66", stroke: "#ee3344", strokeWidth: 8 });
    await page.reload(); await openAtlas(page); await canvas(page);
    await page.getByRole("button", { name: "Выбрать объект Сосновый лес", exact: true }).click();
    await expect(page.getByLabel("Контур объекта", { exact: true })).toHaveValue("#ee3344");
    await expect.poll(() => pixel(page, [400, 350])).toEqual([34, 204, 102]);
    await expect.poll(() => redContourPixels(page)).toBeGreaterThanOrEqual(narrow + 4);
  } finally { await cleanup(page, project.id); }
});

test("видимость, порядок, прозрачность и блокировка слоёв действительно меняют карту и сохраняются", async ({ page }) => {
  test.setTimeout(150000);
  const { project, world } = await setup(page);
  const seeded = await seed(page, world.id, true);
  try {
    await page.goto("/"); await openAtlas(page); await canvas(page);
    await expect.poll(() => pixel(page, [400, 350])).toEqual([119, 153, 102]);
    const visible = page.getByRole("checkbox", { name: "Показать слой Краски поверх", exact: true });
    await visible.uncheck(); await expect.poll(() => pixel(page, [400, 350])).toEqual([51, 85, 119]);
    await visible.check(); await expect.poll(() => pixel(page, [400, 350])).toEqual([119, 153, 102]);
    await setRange(page.getByRole("slider", { name: "Непрозрачность слоя Краски поверх", exact: true }), "0.5");
    await expect.poll(async () => (await pixel(page, [400, 350])).every((channel, index) => Math.abs(channel - [85, 119, 111][index]) <= 1)).toBe(true);
    await setRange(page.getByRole("slider", { name: "Непрозрачность слоя Краски поверх", exact: true }), "1");
    await page.getByRole("button", { name: "Опустить слой Краски поверх", exact: true }).click();
    await page.getByRole("button", { name: "Опустить слой Краски поверх", exact: true }).click();
    await expect.poll(() => pixel(page, [400, 350])).toEqual([51, 85, 119]);
    await page.getByRole("button", { name: "Поднять слой Краски поверх", exact: true }).click();
    await page.getByRole("button", { name: "Поднять слой Краски поверх", exact: true }).click();
    await expect.poll(() => pixel(page, [400, 350])).toEqual([119, 153, 102]);
    const politicalVisible = page.getByRole("checkbox", { name: `Показать слой ${seeded.political.name}`, exact: true });
    await expect(politicalVisible).not.toBeChecked();
    await politicalVisible.check();
    await expect(page.getByRole("button", { name: "Политическая карта", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => pixel(page, [775, 475])).toEqual([204, 136, 68]);
    await page.getByRole("button", { name: "Выбрать объект Сосновый лес", exact: true }).click();
    await page.getByRole("button", { name: "Заблокировать слой Краски поверх", exact: true }).click();
    await expect(page.getByRole("button", { name: "Переместить объекты", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Заливка объекта", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Разблокировать слой Краски поверх", exact: true }).click();
    await expect(page.getByLabel("Заливка объекта", { exact: true })).toBeEnabled();
    await page.getByRole("combobox", { name: "Слой выбранного объекта", exact: true }).selectOption(seeded.political.id);
    await page.getByRole("checkbox", { name: `Показать слой ${seeded.political.name}`, exact: true }).uncheck();
    await expect.poll(() => pixel(page, [400, 350])).toEqual([51, 85, 119]);
    await save(page);
    const stored = await mapState(page, seeded.data.map.id);
    expect(stored.features.find((value) => value.id === seeded.targetId)?.layerId).toBe(seeded.political.id);
    expect(stored.layers.find((value) => value.id === seeded.political.id)?.visible).toBe(false);
    await page.reload(); await openAtlas(page); await canvas(page);
    await expect(page.getByRole("checkbox", { name: `Показать слой ${seeded.political.name}`, exact: true })).not.toBeChecked();
    await expect.poll(() => pixel(page, [400, 350])).toEqual([51, 85, 119]);
  } finally { await cleanup(page, project.id); }
});

test("готовая основа и пустая карта создаются отдельно, а сгенерированные объекты редактируются и сохраняются", async ({ page }) => {
  test.setTimeout(180000);
  const { project, world } = await setup(page);
  try {
    await page.goto("/"); await openAtlas(page);
    await page.getByRole("button", { name: "Новая карта", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Новая карта", exact: true });
    await dialog.getByRole("radio", { name: "Готовая основа", exact: true }).check();
    await dialog.getByRole("textbox", { name: "Название карты", exact: true }).fill("Готовый остров приключений");
    await dialog.getByRole("combobox", { name: "Тип основы", exact: true }).selectOption("island");
    await dialog.getByRole("textbox", { name: "Сид карты", exact: true }).fill("simple-map-e2e-2026");
    const [generatedResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/worlds/${world.id}/maps/generate`),
      dialog.getByRole("button", { name: "Создать карту", exact: true }).click(),
    ]);
    expect(generatedResponse.status(), await generatedResponse.text()).toBe(201);
    const generated = await generatedResponse.json() as MapData;
    await expect(dialog).toHaveCount(0); await canvas(page);
    expect(generated.features.length).toBeGreaterThan(10);
    expect(generated.features.some((value) => value.kind === "continent" || value.kind === "island")).toBe(true);
    await page.screenshot({ path: "/tmp/lore-050-generated-desktop.png", fullPage: true });
    const terrain = generated.features.find((value) => value.kind === "forest")!; expect(terrain).toBeDefined();
    await page.getByRole("button", { name: `Выбрать объект ${terrain.name}`, exact: true }).click();
    await setColor(page.getByLabel("Заливка объекта", { exact: true }), "#114422");
    await save(page);
    expect((await mapState(page, generated.map.id)).features.find((value) => value.id === terrain.id)?.fill).toBe("#114422");
    await page.reload(); await openAtlas(page); await canvas(page);
    await expect(page.getByText("simple-map-e2e-2026", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Новая карта", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Новая карта", exact: true });
    await dialog.getByRole("radio", { name: "Пустая карта", exact: true }).check();
    await dialog.getByRole("textbox", { name: "Название карты", exact: true }).fill("Чистый лист нового мира");
    const [emptyResponse] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/worlds/${world.id}/maps`),
      dialog.getByRole("button", { name: "Создать карту", exact: true }).click(),
    ]);
    expect(emptyResponse.status(), await emptyResponse.text()).toBe(201);
    const empty = await emptyResponse.json() as MapData;
    expect(empty.features).toEqual([]); expect(empty.map.id).not.toBe(generated.map.id);
    await expect(dialog).toHaveCount(0); await canvas(page);
    expect((await mapState(page, generated.map.id)).features.find((value) => value.id === terrain.id)?.fill).toBe("#114422");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("combobox", { name: "Карта мира", exact: true }).selectOption(generated.map.id);
    await canvas(page);
    await page.getByRole("button", { name: `Выбрать объект ${terrain.name}`, exact: true }).click();
    await expect(page.getByLabel("Заливка объекта", { exact: true })).toHaveValue("#114422");
    await page.screenshot({ path: "/tmp/lore-050-generated-mobile.png", fullPage: true });
  } finally { await cleanup(page, project.id); }
});
