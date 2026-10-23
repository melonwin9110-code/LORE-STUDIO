import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:3001";
export default defineConfig({
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
    command: "npm run dev -- --port 3001",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !!process.env.TEST_BASE_URL || !process.env.CI,
    timeout: 120000,
  },
});
