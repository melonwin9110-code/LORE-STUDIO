const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
const response = await fetch(`${base}/api/health`);
const health = await response.json();
if (!response.ok || health.testDatabase !== true) {
  throw new Error("Интеграционные тесты остановлены: сервер должен работать с отдельной базой *_test");
}
export {};
