import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { registerThroughApi, uniqueName } from "./helpers";
import type { Character, Project, World, WorldData } from "../../src/lib/types";
import type { Timeline } from "../../src/lib/history-types";
import type { WikiPage } from "../../src/lib/wiki-types";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin;
test.use({ actionTimeout: 15000, viewport: { width: 1500, height: 1050 } });

const articleDocument = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const input = (title: string, text: string, sourceId: string | null = null) => ({ title, summary: "Авторская запись энциклопедии", category: "Летописи", tags: ["история"], knowledge: "fact", sourceId, document: articleDocument(text) });

async function setup(page: Page) {
  await registerThroughApi(page.request);
  const created = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name: uniqueName("Энциклопедия 0.6") } });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = await created.json() as { project: Project };
  const made = await page.request.post(`/api/projects/${project.id}/worlds`, { headers: { Origin: origin }, data: { name: "Мир живой энциклопедии" } });
  expect(made.status(), await made.text()).toBe(201);
  const { world } = await made.json() as { world: World };
  const state = await page.request.get(`/api/worlds/${world.id}`);
  expect(state.status(), await state.text()).toBe(200);
  const main = (await state.json() as WorldData).history!.timeline;
  return { project, world, main };
}
async function cleanup(page: Page, id: string) {
  const deleted = await page.request.delete(`/api/projects/${id}`, { headers: { Origin: origin } });
  expect(deleted.status(), await deleted.text()).toBe(200);
}
async function hero(page: Page, worldId: string) {
  const created = await page.request.post(`/api/worlds/${worldId}/characters`, { headers: { Origin: origin }, data: { name: "Лиора Хранительница", biography: "Первоначальные структурированные факты о Лиоре", birthYear: 12 } });
  expect(created.status(), await created.text()).toBe(201);
  return (await created.json() as { character: Character }).character;
}
async function openWiki(page: Page) {
  await expect(page.getByRole("navigation", { name: "Разделы мира", exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("navigation", { name: "Разделы мира", exact: true }).getByRole("button", { name: "Энциклопедия", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Энциклопедия", exact: true })).toBeVisible();
}
async function openMaterial(page: Page, title: string) {
  await page.getByRole("button", { name: `Открыть материал ${title}`, exact: true }).first().click();
  await expect(page.getByRole("article", { name: "Материал энциклопедии", exact: true }).getByRole("heading", { name: title, exact: true })).toBeVisible();
}
async function save(page: Page, method: "POST" | "PATCH") {
  const [response] = await Promise.all([
    page.waitForResponse((value) => value.request().method() === method && (method === "POST" ? /\/api\/worlds\/[^/]+\/wiki$/.test(new URL(value.url()).pathname) : /\/api\/wiki-articles\/[^/]+$/.test(new URL(value.url()).pathname))),
    page.getByRole("button", { name: "Сохранить статью", exact: true }).click(),
  ]);
  expect(response.status(), await response.text()).toBe(method === "POST" ? 201 : 200);
  await expect(page.getByRole("button", { name: "Редактировать статью", exact: true })).toBeVisible();
  return response.json() as Promise<WikiPage>;
}
async function read(page: Page, worldId: string, entryId: string, timeline?: string) {
  const response = await page.request.get(`/api/worlds/${worldId}/wiki/${entryId}${timeline ? `?timeline=${timeline}` : ""}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<WikiPage>;
}
function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [node, ...(Array.isArray(node.content) ? node.content.flatMap(nodes) : [])];
}

test("автор пишет форматированную статью с таблицей, изображением и внутренними ссылками, а чтение и поиск сохраняются", async ({ page }) => {
  test.setTimeout(150000);
  const { project, world } = await setup(page);
  const character = await hero(page, world.id);
  const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 38, g: 98, b: 170 } } }).png().toBuffer();
  const uploadedPortrait = await page.request.put(`/api/characters/${character.id}/portrait`, { headers: { Origin: origin, "Content-Type": "image/png" }, data: png });
  expect(uploadedPortrait.status(), await uploadedPortrait.text()).toBe(200);
  const madeMap = await page.request.post(`/api/worlds/${world.id}/maps`, { headers: { Origin: origin }, data: { name: "Атлас Северного сияния" } });
  expect(madeMap.status(), await madeMap.text()).toBe(201);
  const map = (await madeMap.json() as { map: { id: string } }).map;
  const title = "Легенда о ночном море", paragraph = "Кристаллопарус освещает древнюю гавань под северными звёздами.";
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/"); await openWiki(page);
    await page.getByRole("button", { name: "Новая статья", exact: true }).click();
    await page.getByRole("textbox", { name: "Название статьи", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Краткое описание статьи", exact: true }).fill("Авторская легенда, связанная с хранительницей и атласом.");
    await page.getByLabel("Категория статьи", { exact: true }).fill("Морские легенды");
    await page.getByRole("textbox", { name: "Теги статьи", exact: true }).fill("звёзды, море");
    await page.getByRole("combobox", { name: "Характер сведений статьи", exact: true }).selectOption("legend");
    const editor = page.getByRole("textbox", { name: "Текст статьи", exact: true });
    await editor.click();
    await page.getByRole("combobox", { name: "Стиль текста", exact: true }).selectOption("heading2");
    await editor.pressSequentially("Паруса под звёздами");
    await editor.press("Enter");
    await page.getByRole("combobox", { name: "Стиль текста", exact: true }).selectOption("paragraph");
    await editor.pressSequentially(paragraph);
    await editor.press("Enter");
    await page.getByRole("combobox", { name: "Стиль текста", exact: true }).selectOption("heading3");
    await editor.pressSequentially("Память путешествия");
    await editor.press("Enter");
    await page.getByRole("combobox", { name: "Стиль текста", exact: true }).selectOption("paragraph");
    await page.getByRole("button", { name: "Полужирный", exact: true }).click();
    await editor.pressSequentially("Память о первом путешествии");
    await page.getByRole("button", { name: "Полужирный", exact: true }).click();
    await editor.press("Enter");
    await page.getByRole("button", { name: "Внутренняя ссылка", exact: true }).click();
    await page.getByRole("combobox", { name: "Объект для ссылки", exact: true }).selectOption(character.id);
    await page.getByRole("textbox", { name: "Подпись внутренней ссылки", exact: true }).fill("Хранительница Северной Звезды");
    await page.getByRole("button", { name: "Вставить ссылку на объект", exact: true }).click();
    await page.getByRole("button", { name: "Карточка персонажа", exact: true }).click();
    await page.getByRole("combobox", { name: "Персонаж для вставки", exact: true }).selectOption(character.id);
    await page.getByRole("button", { name: "Вставить карточку персонажа", exact: true }).click();
    await page.getByRole("button", { name: "Встроенная карта", exact: true }).click();
    await page.getByRole("combobox", { name: "Карта для вставки", exact: true }).selectOption(map.id);
    await page.getByRole("button", { name: "Вставить карту", exact: true }).click();
    await page.getByLabel("Изображение статьи", { exact: true }).setInputFiles({ name: "my-sea.png", mimeType: "image/png", buffer: png });
    await expect(editor.locator('img[src^="/api/wiki-images/"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Таблица", exact: true }).click();
    await expect(editor.locator("table")).toHaveCount(1);
    await editor.locator("th").first().click();
    await page.keyboard.insertText("Северный маяк");
    const created = await save(page, "POST");
    const storedNodes = nodes(created.article!.document);
    expect(storedNodes.some((node) => node.type === "heading")).toBe(true);
    expect(storedNodes.some((node) => node.type === "text" && node.text === "Память о первом путешествии" && Array.isArray(node.marks) && node.marks.some((mark: { type: string }) => mark.type === "bold"))).toBe(true);
    expect(storedNodes.filter((node) => ["loreLink", "characterCard", "mapEmbed", "image", "table"].includes(String(node.type)))).toHaveLength(5);
    await page.reload(); await openWiki(page); await openMaterial(page, title);
    const material = page.getByRole("article", { name: "Материал энциклопедии", exact: true });
    await expect(material.getByRole("heading", { name: "Паруса под звёздами", exact: true })).toBeVisible();
    await expect(material).toContainText(paragraph); await expect(material.locator("table")).toContainText("Северный маяк");
    const image = material.locator('img[src^="/api/wiki-images/"]');
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
    const portrait = material.locator('img[src*="/api/characters/"]');
    await expect(portrait).toHaveCount(1);
    await expect.poll(() => portrait.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
    await expect(material.getByRole("img", { name: "Карта Атлас Северного сияния", exact: true })).toBeVisible();
    await expect(material).not.toContainText("/api/characters/");
    await expect(page.getByRole("link", { name: "Паруса под звёздами", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Поиск по энциклопедии", exact: true }).fill("Кристаллопарус");
    await expect(page.getByRole("button", { name: `Открыть материал ${title}`, exact: true }).first()).toBeVisible();
    await page.locator("summary").filter({ hasText: "Фильтры" }).click();
    await page.getByRole("combobox", { name: "Категория материалов", exact: true }).selectOption("Морские легенды");
    await page.getByRole("combobox", { name: "Метка материалов", exact: true }).selectOption("море");
    await page.getByRole("combobox", { name: "Характер сведений", exact: true }).selectOption("legend");
    await expect(page.getByRole("button", { name: `Открыть материал ${title}`, exact: true }).first()).toBeVisible();
    await page.getByRole("searchbox", { name: "Поиск по энциклопедии", exact: true }).fill("");
    await page.getByRole("combobox", { name: "Категория материалов", exact: true }).selectOption("");
    await page.getByRole("combobox", { name: "Метка материалов", exact: true }).selectOption("");
    await page.getByRole("combobox", { name: "Характер сведений", exact: true }).selectOption("");
    await material.getByText("Хранительница Северной Звезды", { exact: true }).click();
    await expect(page.getByRole("article", { name: "Материал энциклопедии", exact: true }).getByRole("heading", { name: character.name, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Обратные ссылки", exact: true })).toContainText(title);
    const facts = page.getByRole("region", { name: "Структурированные факты", exact: true });
    await expect(facts.locator('img[src*="/api/characters/"]')).toHaveCount(1);
    await expect.poll(() => facts.locator('img[src*="/api/characters/"]').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
    await expect(facts).not.toContainText("/api/characters/");
    expect((await read(page, world.id, character.id)).backlinks.some((entry) => entry.id === created.article!.id)).toBe(true);
    await openMaterial(page, title);
    await page.screenshot({ path: "/tmp/lore-060-wiki-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "Редактировать статью", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Текст статьи", exact: true })).toContainText(paragraph);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: "/tmp/lore-060-wiki-mobile.png", fullPage: true });
    const selectedCard = editor.locator(".node-characterCard");
    await selectedCard.click();
    await expect(selectedCard).toHaveClass(/ProseMirror-selectednode/);
    await page.getByRole("button", { name: "Внутренняя ссылка", exact: true }).click();
    await page.getByRole("combobox", { name: "Объект для ссылки", exact: true }).selectOption(character.id);
    await page.getByRole("textbox", { name: "Подпись внутренней ссылки", exact: true }).fill("Новая ссылка с мобильного экрана");
    await page.getByRole("button", { name: "Вставить ссылку на объект", exact: true }).click();
    const selectedMap = editor.locator(".node-mapEmbed");
    await selectedMap.click();
    await expect(selectedMap).toHaveClass(/ProseMirror-selectednode/);
    await page.getByRole("button", { name: "Внешняя ссылка", exact: true }).click();
    await page.getByRole("textbox", { name: "Веб-адрес", exact: true }).fill("https://example.com/lore");
    await page.getByRole("textbox", { name: "Текст внешней ссылки", exact: true }).fill("Архив путешествий");
    await page.getByRole("button", { name: "Добавить внешнюю ссылку", exact: true }).click();
    const mobileUpdate = await save(page, "PATCH");
    const updatedNodes = nodes(mobileUpdate.article!.document);
    for (const kind of ["characterCard", "mapEmbed", "image", "table"]) expect(updatedNodes.filter((node) => node.type === kind)).toHaveLength(1);
    expect(updatedNodes.filter((node) => node.type === "loreLink")).toHaveLength(2);
    expect(updatedNodes.some((node) => node.type === "text" && node.text === "Архив путешествий" && Array.isArray(node.marks) && node.marks.some((mark: { type: string; attrs?: { href?: string } }) => mark.type === "link" && mark.attrs?.href === "https://example.com/lore"))).toBe(true);
    await expect(material).toContainText(paragraph);
    await expect(material.getByRole("link", { name: "Архив путешествий", exact: true })).toHaveAttribute("href", "https://example.com/lore");
    await expect(material.getByRole("button", { name: "Новая ссылка с мобильного экрана", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await cleanup(page, project.id); }
});

test("авторский текст отделён от автоматических фактов, а история ветки сохраняет собственную статью", async ({ page }) => {
  test.setTimeout(120000);
  const { project, world, main } = await setup(page), character = await hero(page, world.id);
  const title = "Летопись хранительницы", original = "Первоначальный авторский рассказ о пути хранительницы.";
  const created = await page.request.post(`/api/worlds/${world.id}/wiki?timeline=${main.id}&day=10`, { headers: { Origin: origin }, data: input(title, original, character.id) });
  expect(created.status(), await created.text()).toBe(201);
  const initial = await created.json() as WikiPage;
  const source = await page.request.get(`/api/worlds/${world.id}?timeline=${main.id}`);
  const head = (await source.json() as WorldData).history!.timeline.headRevision;
  const forked = await page.request.post(`/api/worlds/${world.id}/timelines`, { headers: { Origin: origin }, data: { name: "Ветка энциклопедии", parentId: main.id, forkDay: "15", expectedParentRevision: head } });
  expect(forked.status(), await forked.text()).toBe(201);
  const branch = (await forked.json() as { timeline: Timeline }).timeline;
  const changed = await page.request.patch(`/api/characters/${character.id}?timeline=${main.id}&day=20`, { headers: { Origin: origin }, data: { version: character.version, biography: "Факты основной истории после ответвления" } });
  expect(changed.status(), await changed.text()).toBe(200);
  const laterText = "Новая авторская летопись основной истории.";
  const mainEdit = await page.request.patch(`/api/wiki-articles/${initial.article!.id}?timeline=${main.id}&day=20`, { headers: { Origin: origin }, data: { version: initial.article!.version, document: articleDocument(laterText) } });
  expect(mainEdit.status(), await mainEdit.text()).toBe(200);
  try {
    await page.goto("/"); await openWiki(page); await openMaterial(page, title);
    await expect(page.getByRole("article", { name: "Материал энциклопедии", exact: true })).toContainText(laterText);
    await expect(page.getByRole("region", { name: "Структурированные факты", exact: true })).toContainText("Факты основной истории после ответвления");
    await page.getByRole("combobox", { name: "Временная линия", exact: true }).selectOption(branch.id);
    await expect(page.getByRole("combobox", { name: "Временная линия", exact: true })).toHaveValue(branch.id);
    await openMaterial(page, title);
    await expect(page.getByRole("article", { name: "Материал энциклопедии", exact: true })).toContainText(original);
    await expect(page.getByRole("region", { name: "Структурированные факты", exact: true })).toContainText("Первоначальные структурированные факты о Лиоре");
    await page.getByRole("button", { name: "Редактировать статью", exact: true }).click();
    await page.getByRole("textbox", { name: "Текст статьи", exact: true }).fill("Рассказ хранительницы в собственной ветке.");
    const edited = await save(page, "PATCH");
    expect(JSON.stringify(edited.article!.document)).toContain("Рассказ хранительницы в собственной ветке.");
    expect(JSON.stringify((await read(page, world.id, initial.article!.id, main.id)).article!.document)).toContain(laterText);
    await page.reload(); await openWiki(page); await openMaterial(page, title);
    await expect(page.getByRole("article", { name: "Материал энциклопедии", exact: true })).toContainText("Рассказ хранительницы в собственной ветке.");
    await page.getByRole("button", { name: "История статьи", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "История статьи", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Просмотреть редакцию / })).toHaveCount(2);
    await dialog.getByRole("button", { name: /^Просмотреть редакцию / }).last().click();
    await expect(dialog.getByRole("region", { name: "Просмотр редакции статьи", exact: true })).toContainText(original);
    await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  } finally { await cleanup(page, project.id); }
});

test("несохранённый черновик защищён при переходе и конфликте, а перечитывание требует явного согласия", async ({ page }) => {
  test.setTimeout(120000);
  const { project, world } = await setup(page), title = "Запись двух редакторов";
  const mapResponse = await page.request.post(`/api/worlds/${world.id}/maps`, { headers: { Origin: origin }, data: { name: "Карта в конце документа" } });
  expect(mapResponse.status(), await mapResponse.text()).toBe(201);
  const mapId = (await mapResponse.json() as { map: { id: string } }).map.id;
  const seeded = input(title, "Исходный текст для совместной проверки.");
  const created = await page.request.post(`/api/worlds/${world.id}/wiki`, { headers: { Origin: origin }, data: { ...seeded, document: { ...seeded.document, content: [...seeded.document.content, { type: "mapEmbed", attrs: { targetId: mapId } }] } } });
  expect(created.status(), await created.text()).toBe(201);
  const initial = await created.json() as WikiPage;
  let releaseFirstIndex!: () => void, firstIndexReceived!: () => void;
  const firstIndexGate = new Promise<void>((resolve) => { releaseFirstIndex = resolve; });
  const firstIndexPending = new Promise<void>((resolve) => { firstIndexReceived = resolve; });
  let indexRequests = 0;
  await page.route((url) => url.pathname === `/api/worlds/${world.id}/wiki`, async (route) => {
    if (route.request().method() !== "GET" || ++indexRequests !== 1) { await route.continue(); return; }
    const response = await route.fetch();
    firstIndexReceived();
    await firstIndexGate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/"); await openWiki(page);
    await firstIndexPending;
    await page.getByRole("button", { name: "Новая статья", exact: true }).click();
    const draftTitle = page.getByRole("textbox", { name: "Название статьи", exact: true });
    const initialEditor = page.getByRole("textbox", { name: "Текст статьи", exact: true });
    await draftTitle.fill("Черновик во время загрузки библиотеки");
    await initialEditor.fill("Этот текст должен пережить запоздавший ответ первого списка.");
    expect(indexRequests).toBe(2);
    releaseFirstIndex();
    await expect(page.getByRole("button", { name: `Открыть материал ${title}`, exact: true }).first()).toBeVisible();
    await expect(draftTitle).toHaveValue("Черновик во время загрузки библиотеки");
    await expect(initialEditor).toContainText("Этот текст должен пережить запоздавший ответ первого списка.");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await openMaterial(page, title);
    await page.getByRole("button", { name: "Редактировать статью", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Текст статьи", exact: true });
    await expect(editor).toBeVisible();
    await expect(page.getByRole("button", { name: "Сохранить статью", exact: true })).toBeDisabled();
    await expect(page.getByText("Все изменения сохранены", { exact: true })).toBeVisible();
    await editor.locator("p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.insertText("Дополнение ");
    await expect(page.getByRole("button", { name: "Сохранить статью", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Отменить правку текста", exact: true }).click();
    await expect(page.getByRole("button", { name: "Сохранить статью", exact: true })).toBeDisabled();
    await expect(editor).toContainText("Исходный текст для совместной проверки.");
    await editor.fill("Мой несохранённый авторский черновик.");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("navigation", { name: "Разделы мира", exact: true }).getByRole("button", { name: "Персонажи", exact: true }).click();
    await expect(editor).toContainText("Мой несохранённый авторский черновик.");
    await expect(page.getByRole("heading", { name: "Энциклопедия", exact: true })).toBeVisible();
    const other = await page.request.patch(`/api/wiki-articles/${initial.article!.id}`, { headers: { Origin: origin }, data: { version: initial.article!.version, document: articleDocument("Сохранённая правка другой вкладки.") } });
    expect(other.status(), await other.text()).toBe(200);
    const [conflict] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/wiki-articles/${initial.article!.id}`),
      page.getByRole("button", { name: "Сохранить статью", exact: true }).click(),
    ]);
    expect(conflict.status(), await conflict.text()).toBe(409);
    await expect(page.getByRole("region", { name: "Энциклопедия мира", exact: true }).getByRole("alert")).toBeVisible();
    await expect(editor).toContainText("Мой несохранённый авторский черновик.");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Перечитать статью", exact: true }).click();
    await expect(editor).toContainText("Мой несохранённый авторский черновик.");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Перечитать статью", exact: true }).click();
    await expect(page.getByRole("article", { name: "Материал энциклопедии", exact: true })).toContainText("Сохранённая правка другой вкладки.");
    expect(JSON.stringify((await read(page, world.id, initial.article!.id)).article!.document)).not.toContain("Мой несохранённый авторский черновик.");
  } finally { releaseFirstIndex(); await cleanup(page, project.id); }
});
