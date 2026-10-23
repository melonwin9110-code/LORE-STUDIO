import { test, expect } from "@playwright/test";
import { registerThroughApi, uniqueName } from "./helpers";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin;

test("приватный проект изолирован между двумя браузерными сессиями", async ({ page, browser }) => {
  await registerThroughApi(page.request);
  const name = uniqueName("Приватный архив");
  const created = await page.request.post("/api/projects", { headers: { Origin: origin }, data: { name, description: "Только для владельца" } });
  expect(created.ok(), await created.text()).toBe(true);
  const { project } = await created.json();
  const worldResponse = await page.request.post(`/api/projects/${project.id}/worlds`, { headers: { Origin: origin }, data: { name: "Скрытый мир", description: "Личная вселенная" } });
  expect(worldResponse.ok(), await worldResponse.text()).toBe(true);
  const { world } = await worldResponse.json();

  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Текущий проект" })).toHaveValue(project.id);

  const otherContext = await browser.newContext({ baseURL: origin });
  try {
    await registerThroughApi(otherContext.request);
    const otherPage = await otherContext.newPage();
    await otherPage.goto("/");
    await expect(otherPage.getByText(name, { exact: true })).toHaveCount(0);
    const otherProjects = await otherContext.request.get("/api/projects");
    expect(otherProjects.ok()).toBe(true);
    expect((await otherProjects.json()).projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: project.id })]));

    expect((await otherContext.request.get(`/api/projects/${project.id}/worlds`)).status()).toBe(404);
    expect((await otherContext.request.get(`/api/worlds/${world.id}`)).status()).toBe(404);
    expect((await otherContext.request.post(`/api/worlds/${world.id}/characters`, {
      headers: { Origin: origin }, data: { name: "Чужой персонаж" },
    })).status()).toBe(404);
    expect((await otherContext.request.delete(`/api/projects/${project.id}`, { headers: { Origin: origin } })).status()).toBe(404);

    const ownerProjects = await page.request.get("/api/projects");
    expect((await ownerProjects.json()).projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: project.id, name })]));
  } finally {
    await otherContext.close();
    const removed = await page.request.delete(`/api/projects/${project.id}`, { headers: { Origin: origin } });
    expect(removed.ok(), await removed.text()).toBe(true);
  }
});
