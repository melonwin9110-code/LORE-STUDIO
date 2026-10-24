import { test, expect, type Page } from "@playwright/test";
import { registerThroughApi, uniqueName } from "./helpers";
import { gregorianYearDay } from "../../src/lib/calendar";
import type { Character, Project, World, WorldData } from "../../src/lib/types";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin;
test.use({ actionTimeout: 15000 });

async function setup(page: Page) {
  await registerThroughApi(page.request);
  const created = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name: uniqueName("История эпох") } });
  expect(created.status(), await created.text()).toBe(201);
  const { project } = await created.json() as { project: Project };
  const worldResponse = await page.request.post(`/api/projects/${project.id}/worlds`, { headers: { Origin: origin }, data: { name: "Элирия во времени" } });
  expect(worldResponse.status(), await worldResponse.text()).toBe(201);
  const { world } = await worldResponse.json() as { world: World };
  const loaded = await page.request.get(`/api/worlds/${world.id}`);
  expect(loaded.status()).toBe(200);
  const data = await loaded.json() as WorldData;
  expect(data.history).toBeDefined();
  return { project, world, main: data.history!.timeline, calendar: data.history!.calendars.find((calendar) => calendar.isDefault)! };
}
async function seedCharacter(page: Page, worldId: string, name: string, birthYear: number, biography: string) {
  const response = await page.request.post(`/api/worlds/${worldId}/characters`, { headers: { Origin: origin }, data: { name, birthYear, biography } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json() as { character: Character }).character;
}
async function section(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Разделы мира" }).getByRole("button", { name, exact: true }).click();
}
async function showYear(page: Page, year: number) {
  const area = page.getByRole("region", { name: "Исторический контекст" });
  await area.getByRole("spinbutton", { name: "Исторический год", exact: true }).fill(String(year));
  await area.getByRole("combobox", { name: "Исторический месяц", exact: true }).selectOption("1");
  await area.getByRole("spinbutton", { name: "Исторический день", exact: true }).fill("1");
  const expectedDay = gregorianYearDay(year).toString();
  await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return /\/api\/worlds\/[^/]+$/.test(url.pathname) && url.searchParams.get("day") === expectedDay && response.status() === 200;
    }),
    area.getByRole("button", { name: "Показать дату", exact: true }).click(),
  ]);
  await expect(area.getByText(`1 января ${year} г.`, { exact: true })).toBeVisible();
}
async function line(page: Page, id: string) {
  const select = page.getByRole("combobox", { name: "Временная линия", exact: true });
  if (await select.inputValue() !== id) {
    await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return /\/api\/worlds\/[^/]+$/.test(url.pathname) && url.searchParams.get("timeline") === id && response.status() === 200;
      }),
      select.selectOption(id),
    ]);
  }
  await expect(select).toHaveValue(id);
}
async function openCharacter(page: Page, name: string) {
  await section(page, "Персонажи");
  await page.getByRole("button").filter({ has: page.getByRole("heading", { name, exact: true }) }).click();
  const dialog = page.getByRole("dialog", { name: "Карточка персонажа" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "История и характер", exact: true }).click();
  return dialog;
}
async function biography(page: Page, name: string, expected: string, replacement?: string) {
  const dialog = await openCharacter(page, name);
  const field = dialog.getByRole("textbox", { name: "Биография", exact: true });
  await expect(field).toHaveValue(expected);
  if (replacement !== undefined) {
    await field.fill(replacement);
    await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } else await dialog.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
}

test("исторические ветки и общее семейное древо сохраняются после перезагрузки", async ({ page }) => {
  test.setTimeout(120000);
  const { project, world, main } = await setup(page);
  const parentName = "Эльвар Основатель", firstName = "Лиора Наследница", siblingName = "Мира Наследница";
  const initial = "Исходная биография Лиоры", historical = "Летопись Лиоры на тысячу первый век", alternative = "Судьба Лиоры в альтернативной истории";
  await seedCharacter(page, world.id, parentName, 0, "Основатель династии");
  await seedCharacter(page, world.id, firstName, 30, initial);
  await seedCharacter(page, world.id, siblingName, 35, "Исходная биография Миры");
  try {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Временная линия", exact: true })).toHaveValue(main.id);
    await showYear(page, 1000);
    await biography(page, firstName, initial, historical);
    await showYear(page, 900);
    await biography(page, firstName, initial);
    await showYear(page, 1000);
    await biography(page, firstName, historical);

    await page.getByRole("button", { name: "Новая линия", exact: true }).click();
    const forkDialog = page.getByRole("dialog", { name: "Новая временная линия", exact: true });
    await forkDialog.getByRole("textbox", { name: "Название линии", exact: true }).fill("Серебряная ветвь");
    await forkDialog.getByRole("button", { name: "Создать линию", exact: true }).click();
    await expect(forkDialog).toHaveCount(0);
    const timelineSelect = page.getByRole("combobox", { name: "Временная линия", exact: true });
    await expect(timelineSelect.locator("option:checked")).toHaveText("Серебряная ветвь");
    const childId = await timelineSelect.inputValue();
    expect(childId).not.toBe(main.id);
    await biography(page, firstName, historical, alternative);

    await page.reload();
    await expect(timelineSelect).toBeVisible();
    await line(page, childId);
    await showYear(page, 1000);
    await biography(page, firstName, alternative);
    await line(page, main.id);
    await biography(page, firstName, historical);
    await biography(page, siblingName, "Исходная биография Миры", "Новая родительская редакция Миры");
    await line(page, childId);
    await biography(page, siblingName, "Исходная биография Миры");

    await section(page, "Семейное древо");
    for (const name of [firstName, siblingName]) {
      await page.getByRole("button", { name: "Добавить родственную связь", exact: true }).click();
      const relationDialog = page.getByRole("dialog");
      await relationDialog.getByRole("combobox", { name: "От персонажа", exact: true }).selectOption({ label: parentName });
      await relationDialog.getByRole("combobox", { name: "К персонажу", exact: true }).selectOption({ label: name });
      await relationDialog.getByRole("combobox", { name: "Семейная связь", exact: true }).selectOption("parent");
      await relationDialog.getByRole("button", { name: "Сохранить родство", exact: true }).click();
      await expect(relationDialog).toHaveCount(0);
    }
    const firstFamily = page.getByRole("article").filter({ has: page.getByRole("heading", { name: firstName, exact: true }) });
    await expect(firstFamily.getByText(parentName, { exact: true })).toBeVisible();
    await expect(firstFamily.getByText(siblingName, { exact: true })).toBeVisible();
    await page.reload();
    await section(page, "Обзор мира");
    await line(page, childId);
    await showYear(page, 1000);
    await section(page, "Семейное древо");
    await expect(firstFamily.getByText(siblingName, { exact: true })).toBeVisible();
    await section(page, "Обзор мира");
    await line(page, main.id);
    await section(page, "Семейное древо");
    // The approved 0.3 family model belongs to the world, independently of its lines.
    await expect(firstFamily.getByText(siblingName, { exact: true })).toBeVisible();

    await section(page, "Обзор мира");
    await page.getByRole("button", { name: "Сравнить временные линии", exact: true }).click();
    const comparison = page.getByRole("dialog", { name: "Сравнение и перенос объектов", exact: true });
    await comparison.getByRole("combobox", { name: "Сравнить с линией", exact: true }).selectOption(childId);
    await comparison.getByRole("button", { name: "Сравнить", exact: true }).click();
    await comparison.getByRole("checkbox", { name: new RegExp(firstName) }).check();
    await comparison.getByRole("checkbox", { name: "Разрешить замену конфликтующих объектов", exact: true }).check();
    page.once("dialog", (dialog) => dialog.accept());
    await comparison.getByRole("button", { name: "Перенести выбранные", exact: true }).click();
    await expect(comparison.getByRole("status")).toContainText("Перенесено объектов: 1.");
    await comparison.getByRole("button", { name: "Закрыть", exact: true }).click();
    await biography(page, firstName, alternative);
    await showYear(page, 900);
    await biography(page, firstName, initial);
  } finally {
    await page.request.delete(`/api/projects/${project.id}`, { headers: { Origin: origin } });
  }
});

test("автор создаёт календарь с високосным циклом и переводит дату без потери после перезагрузки", async ({ page }) => {
  const { project, calendar } = await setup(page);
  const calendarName = uniqueName("Две луны");
  try {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Временная линия", exact: true })).toBeVisible();
    await section(page, "Календари");
    await page.getByRole("button", { name: "Новый календарь", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Новый календарь", exact: true });
    await dialog.getByRole("textbox", { name: "Название календаря", exact: true }).fill(calendarName);
    await dialog.getByRole("textbox", { name: "Название эры", exact: true }).fill("Эра двух лун");
    await dialog.getByRole("textbox", { name: "Месяцы календаря", exact: true }).fill("Заря:10\nСумерки:20");
    await dialog.getByRole("checkbox", { name: "Добавлять високосные дни", exact: true }).check();
    await dialog.getByRole("spinbutton", { name: "Високосный цикл", exact: true }).fill("3");
    await dialog.getByRole("spinbutton", { name: "Високосный месяц", exact: true }).fill("2");
    await dialog.getByRole("button", { name: "Создать календарь", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { name: calendarName, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Временная линия", exact: true })).toBeVisible();
    await section(page, "Календари");
    await expect(page.getByRole("heading", { name: calendarName, exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Исходный календарь", exact: true }).selectOption({ label: calendarName });
    await page.getByRole("combobox", { name: "Целевой календарь", exact: true }).selectOption(calendar.id);
    await page.getByRole("spinbutton", { name: "Год для перевода", exact: true }).fill("1");
    await page.getByRole("combobox", { name: "Год для перевода месяц", exact: true }).selectOption("1");
    await page.getByRole("spinbutton", { name: "Год для перевода день", exact: true }).fill("1");
    await page.getByRole("button", { name: "Перевести дату", exact: true }).click();
    await expect(page.getByLabel("Результат перевода", { exact: true })).toHaveText("1 февраля 0 г. · Григорианский");
  } finally {
    await page.request.delete(`/api/projects/${project.id}`, { headers: { Origin: origin } });
  }
});
