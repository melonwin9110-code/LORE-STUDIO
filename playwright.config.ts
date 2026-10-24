import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
const testDatabaseURL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
if (!decodeURIComponent(new URL(testDatabaseURL).pathname.slice(1)).endsWith("_test")) {
  throw new Error("Для браузерных проверок задайте TEST_DATABASE_URL отдельной базы с окончанием _test");
}
export default defineConfig({
  globalSetup: "./scripts/check-test-server.ts",
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : {},
  },
  webServer: {
    env: { DATABASE_URL: testDatabaseURL },
    command: "npm run dev -- --port 3001",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !!process.env.TEST_BASE_URL || !process.env.CI,
    timeout: 120000,
  },
});
