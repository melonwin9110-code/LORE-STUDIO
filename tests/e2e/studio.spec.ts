import { test, expect, type Page } from "@playwright/test";
import { account, uniqueName } from "./helpers";

test.use({ actionTimeout: 15000 });
async function section(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Разделы мира" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function save(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function openCharacter(page: Page, name: string) {
  await page.getByRole("button").filter({ has: page.getByRole("heading", { name, exact: true }) }).click();
  await expect(page.getByRole("dialog", { name: "Карточка персонажа" })).toBeVisible();
}

test("автор создаёт мир, редактирует биографию, события и отношения с сохранением после перезагрузки", async ({ page }) => {
  test.setTimeout(120000);
  const credentials = account();
  const projectName = uniqueName("Летопись"), worldName = uniqueName("Звёздный берег");
  const firstName = "Ариэль Северная", secondName = "Торен Смотритель";
  const biography = "Выросла у северного моря. Ведёт летопись исчезнувшего города.";
  const editedBiography = `${biography} Нашла карту древнего маяка.`;
  const eventName = "Открытие маяка", eventDescription = "Ариэль и Торен зажгли свет над морем.";
  const relationKind = "Союз первопроходцев";

  await page.goto("/");
  await expect(page.getByText("ElpisHeart", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Регистрация", exact: true }).click();
  await page.getByLabel("Ваше имя").fill(credentials.name);
  await page.getByLabel("Электронная почта").fill(credentials.email);
  await page.getByLabel("Пароль", { exact: false }).fill(credentials.password);
  await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ваши вселенные" })).toBeVisible();

  try {
    await page.getByRole("button", { name: "Создать проект", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Название проекта").fill(projectName);
    await page.getByRole("dialog").getByLabel("Описание", { exact: true }).fill("История нового мира");
    await save(page);
    await page.getByRole("button", { name: "Создать мир", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Название мира").fill(worldName);
    await page.getByRole("dialog").getByLabel("Описание", { exact: true }).fill("Мир маяков и мореплавателей");
    await save(page);
    await expect(page.getByRole("heading", { name: worldName, exact: true })).toBeVisible();

    await section(page, "Персонажи");
    await page.getByRole("button", { name: "Создать персонажа", exact: true }).click();
    let editor = page.getByRole("dialog");
    await editor.getByLabel("Имя персонажа").fill(firstName);
    await editor.getByLabel("Раса / вид").fill("Человек");
    await editor.getByLabel("Год рождения").fill("1170");
    await editor.getByRole("combobox", { name: "Статус", exact: true }).selectOption("canon");
    await editor.getByRole("tab", { name: "История и характер" }).click();
    await editor.getByRole("textbox", { name: "Биография", exact: true }).fill(biography);
    await save(page);
    await expect(page.getByRole("heading", { name: firstName, exact: true })).toBeVisible();

    await openCharacter(page, firstName);
    editor = page.getByRole("dialog");
    await editor.getByRole("tab", { name: "История и характер" }).click();
    await expect(editor.getByRole("textbox", { name: "Биография", exact: true })).toHaveValue(biography);
    await editor.getByRole("textbox", { name: "Биография", exact: true }).fill(editedBiography);
    await save(page);
    await page.reload();
    await section(page, "Персонажи");
    await openCharacter(page, firstName);
    editor = page.getByRole("dialog");
    await editor.getByRole("tab", { name: "История и характер" }).click();
    await expect(editor.getByRole("textbox", { name: "Биография", exact: true })).toHaveValue(editedBiography);
    await editor.getByRole("button", { name: "Закрыть редактор" }).click();

    await page.getByRole("button", { name: "Создать персонажа", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Имя персонажа").fill(secondName);
    await save(page);

    await section(page, "Хронология");
    await page.getByRole("button", { name: "Добавить событие", exact: true }).click();
    editor = page.getByRole("dialog");
    await editor.getByLabel("Название события").fill(eventName);
    await editor.getByLabel("Год начала").fill("1200");
    await editor.getByRole("textbox", { name: "Описание события", exact: true }).fill(eventDescription);
    await editor.getByRole("checkbox", { name: firstName, exact: true }).check();
    await editor.getByRole("checkbox", { name: secondName, exact: true }).check();
    await save(page);
    await page.reload();
    await section(page, "Хронология");
    await expect(page.getByRole("heading", { name: eventName, exact: true })).toBeVisible();
    await page.getByRole("button").filter({ has: page.getByRole("heading", { name: eventName, exact: true }) }).click();
    editor = page.getByRole("dialog");
    await expect(editor.getByRole("textbox", { name: "Описание события", exact: true })).toHaveValue(eventDescription);
    await expect(editor.getByRole("checkbox", { name: firstName, exact: true })).toBeChecked();
    await editor.getByLabel("Год окончания").fill("1201");
    await save(page);

    await section(page, "Отношения");
    await page.getByRole("button", { name: "Добавить отношение", exact: true }).click();
    editor = page.getByRole("dialog");
    await editor.getByLabel("От персонажа").selectOption({ label: firstName });
    await editor.getByLabel("К персонажу").selectOption({ label: secondName });
    await editor.getByLabel("Тип отношения").fill(relationKind);
    await editor.getByLabel("Год начала").fill("1200");
    await save(page);
    await page.reload();
    await section(page, "Отношения");
    await expect(page.getByText(relationKind, { exact: true })).toBeVisible();
    await page.getByRole("button").filter({ has: page.getByText(relationKind, { exact: true }) }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog").getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.getByText(relationKind, { exact: true })).toHaveCount(0);

    await section(page, "Хронология");
    await page.getByRole("button").filter({ has: page.getByRole("heading", { name: eventName, exact: true }) }).click();
    await expect(page.getByRole("dialog").getByLabel("Год окончания")).toHaveValue("1201");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog").getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.getByRole("heading", { name: eventName, exact: true })).toHaveCount(0);

    await section(page, "Персонажи");
    await openCharacter(page, secondName);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog").getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.getByRole("heading", { name: secondName, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page.getByRole("button", { name: "Войти в мастерскую", exact: true })).toBeVisible();
    expect((await page.request.get("/api/projects")).status()).toBe(401);

    await page.getByLabel("Электронная почта").fill(credentials.email);
    await page.getByLabel("Пароль", { exact: false }).fill(credentials.password);
    await page.getByRole("button", { name: "Войти в мастерскую", exact: true }).click();
    await section(page, "Персонажи");
    await expect(page.getByRole("heading", { name: firstName, exact: true })).toBeVisible();
  } finally {
    const projectsResponse = await page.request.get("/api/projects").catch(() => null);
    if (projectsResponse?.ok()) {
      const { projects } = await projectsResponse.json();
      const ownProject = projects.find((project: { name: string }) => project.name === projectName);
      if (ownProject) await page.request.delete(`/api/projects/${ownProject.id}`, { headers: { Origin: new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin } }).catch(() => null);
    }
  }
});

test("мобильная форма и выбранная тема сохраняются после обновления", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Войти в мастерскую", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Сменить тему", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Войти в мастерскую", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
