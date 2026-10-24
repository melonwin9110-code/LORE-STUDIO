import type { FullConfig } from "@playwright/test";

export default async function checkTestServer(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("Не задан адрес тестового сервера");
  const response = await fetch(`${baseURL}/api/health`);
  const health = await response.json();
  if (!response.ok || health.testDatabase !== true) {
    throw new Error("Браузерные тесты остановлены: сервер должен работать с отдельной базой *_test");
  }
}
