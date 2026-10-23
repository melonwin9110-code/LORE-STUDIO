import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { NextRequest } from "next/server";
import type { User } from "@/lib/types";
import { pool } from "./db";
import { ApiError } from "./errors";

export const SESSION_COOKIE = "lore_session";
const lifetime = 7 * 24 * 60 * 60;
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, expectedHex] = stored.split("$");
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored)) return false;
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}
export async function dummyPasswordWork(password: string): Promise<void> { await derive(password, Buffer.alloc(16)); }
export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function sessionCookie(token: string, clear = false): string {
  return `${SESSION_COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : lifetime}${process.env.SECURE_COOKIES === "true" ? "; Secure" : ""}`;
}
export async function createSession(client: PoolClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await client.query("DELETE FROM sessions WHERE expires_at < now()");
  await client.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')", [tokenHash(token), userId]);
  return token;
}
export async function getUser(request: NextRequest): Promise<User | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await pool.query<User>("SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", [tokenHash(token)]);
  return result.rows[0] ?? null;
}
export async function requireUser(request: NextRequest): Promise<User> {
  const user = await getUser(request);
  if (!user) throw new ApiError(401, "Войдите в аккаунт");
  return user;
}
export async function limitLogin(email: string): Promise<void> {
  const result = await pool.query<{ attempts: number }>(`INSERT INTO auth_attempts(key, attempts, expires_at) VALUES($1,1,now()+interval '15 minutes')
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN auth_attempts.expires_at < now() THEN 1 ELSE auth_attempts.attempts+1 END,
    expires_at=CASE WHEN auth_attempts.expires_at < now() THEN now()+interval '15 minutes' ELSE auth_attempts.expires_at END RETURNING attempts`, [tokenHash(email)]);
  if (result.rows[0].attempts > 10) throw new ApiError(429, "Слишком много попыток входа. Повторите через 15 минут");
}
