import { expect, type APIRequestContext } from "@playwright/test";

export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function account() {
  return {
    name: uniqueName("Исследователь"),
    email: `lore-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    password: "Lore-e2e-password-2026",
  };
}

export async function registerThroughApi(request: APIRequestContext) {
  const credentials = account();
  const response = await request.post("/api/auth/register", {
    data: credentials,
    headers: { Origin: new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:3001").origin },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return credentials;
}
