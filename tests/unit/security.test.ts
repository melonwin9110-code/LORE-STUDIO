import { describe, expect, it } from "vitest";
import { hashPassword, sessionCookie, tokenHash, verifyPassword } from "../../src/server/auth";
import { characterPatch, characterSchema, credentialsSchema, eventPatch, eventSchema, registrationSchema, relationSchema } from "../../src/server/validation";

describe("password and session security", () => {
  it("salts password hashes independently and verifies correct passwords only", async () => {
    const first = await hashPassword("A-long-password-2026!");
    const second = await hashPassword("A-long-password-2026!");
    expect(first).not.toEqual(second);
    expect(first).not.toContain("A-long-password");
    expect(await verifyPassword("A-long-password-2026!", first)).toBe(true);
    expect(await verifyPassword("Wrong-password", first)).toBe(false);
    expect(await verifyPassword("anything", "corrupt-hash")).toBe(false);
  });
  it("hashes opaque sessions before persistence and clears cookies explicitly", () => {
    expect(tokenHash("session-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash("another-token")).not.toEqual(tokenHash("session-token"));
    expect(sessionCookie("abc")).toContain("HttpOnly; SameSite=Lax");
    expect(sessionCookie("abc", true)).toContain("lore_session=; Path=/");
    expect(sessionCookie("abc", true)).toContain("Max-Age=0");
  });
  it("requires a long bounded password, normalizes email and forbids unknown fields", () => {
    expect(registrationSchema.safeParse({ name: "Автор", email: "author@example.test", password: "short" }).success).toBe(false);
    expect(credentialsSchema.safeParse({ email: "author@example.test", password: "x".repeat(129) }).success).toBe(false);
    expect(credentialsSchema.parse({ email: "AUTHOR@example.test", password: "x".repeat(10) }).email).toBe("author@example.test");
    expect(registrationSchema.safeParse({ name: "Автор", email: "author@example.test", password: "x".repeat(10), role: "admin" }).success).toBe(false);
  });
});

describe("world data validation", () => {
  it("accepts ancient dates and applies create defaults", () => {
    const character = characterSchema.parse({ name: "  Лиора  ", birthYear: -100000 });
    expect(character.name).toBe("Лиора");
    expect(character.birthYear).toBe(-100000);
    expect(character.deathYear).toBeNull();
    expect(character.biography).toBe("");
    expect(character.status).toBe("draft");
  });
  it("keeps missing PATCH fields absent instead of resetting saved data", () => {
    expect(characterPatch.parse({ version: 1, biography: "Новый текст" })).toEqual({ version: 1, biography: "Новый текст" });
    expect(eventPatch.parse({ version: 2, description: "Правка" })).toEqual({ version: 2, description: "Правка" });
  });
  it("requires a version for conflict detection", () => {
    expect(characterPatch.safeParse({ biography: "Правка" }).success).toBe(false);
    expect(characterPatch.safeParse({ version: 0 }).success).toBe(false);
  });
  it("rejects historical contradictions", () => {
    expect(characterSchema.safeParse({ name: "Тарен", birthYear: 10, deathYear: 9 }).success).toBe(false);
    expect(eventSchema.safeParse({ name: "Война", startYear: 20, endYear: 19 }).success).toBe(false);
  });
  it.each([1.5, Number.POSITIVE_INFINITY, 1_000_000_001, -1_000_000_001])("rejects invalid year %s", (startYear) => {
    expect(eventSchema.safeParse({ name: "Событие", startYear }).success).toBe(false);
  });
  it("rejects duplicated event participants", () => {
    const id = "f1191d39-5db6-4b8a-908c-3196dc59c303";
    expect(eventSchema.safeParse({ name: "Совет", startYear: 0, characterIds: [id, id] }).success).toBe(false);
  });
  it("rejects self relationships and inverted relationship dates", () => {
    const fromId = "f1191d39-5db6-4b8a-908c-3196dc59c303";
    const toId = "a1191d39-5db6-4b8a-908c-3196dc59c303";
    expect(relationSchema.safeParse({ fromId, toId: fromId, kind: "Дружба" }).success).toBe(false);
    expect(relationSchema.safeParse({ fromId, toId, kind: "Дружба", startYear: 2, endYear: 1 }).success).toBe(false);
  });
});
