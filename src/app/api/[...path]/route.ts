import { NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { pool, transaction } from "@/server/db";
import { ApiError } from "@/server/errors";
import { createSession, dummyPasswordWork, getUser, hashPassword, limitLogin, requireUser, SESSION_COOKIE, sessionCookie, tokenHash, verifyPassword } from "@/server/auth";
import { characterPatch, characterSchema, credentialsSchema, eventPatch, eventSchema, idSchema, projectPatch, projectSchema, registrationSchema, relationPatch, relationSchema, worldSchema } from "@/server/validation";
import { audit, createEntity, createProject, createWorld, loadWorld, mutateEntity, projectAccess, worldAccess } from "@/server/repository";
import { createDemo } from "@/server/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const maxBody = 256 * 1024;

function json(value: unknown, status = 200, cookie?: string) {
  const response = NextResponse.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if (cookie) response.headers.set("Set-Cookie", cookie);
  return response;
}
async function body<T>(request: NextRequest, schema: ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Ожидается JSON");
  if (Number(request.headers.get("content-length")) > maxBody) throw new ApiError(413, "Слишком большой запрос");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Пустой запрос");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBody) { await reader.cancel(); throw new ApiError(413, "Слишком большой запрос"); }
    chunks.push(value);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Некорректный JSON"); }
  return schema.parse(data);
}
function csrf(request: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  // Next may normalize nextUrl's hostname to its bind address. The HTTP Host is
  // the browser's requested authority; do not accept arbitrary forwarded hosts.
  const expected = process.env.APP_URL ? new URL(process.env.APP_URL).origin
    : new URL(`${request.nextUrl.protocol}//${request.headers.get("host") ?? request.nextUrl.host}`).origin;
  if (request.headers.get("origin") !== expected) throw new ApiError(403, "Недопустимый источник запроса");
}
function uuid(value: string) { if (!idSchema.safeParse(value).success) throw new ApiError(404, "Объект не найден"); return value; }

async function dispatch(request: NextRequest, path: string[]) {
  csrf(request);
  const method = request.method;
  const key = path.join("/");
  if (key === "health" && method === "GET") {
    const result = await pool.query("SELECT name FROM schema_migrations WHERE name='001_initial.sql'");
    if (!result.rowCount) throw new ApiError(503, "Необходимо применить миграции");
    return json({ status: "ok", database: "connected" });
  }
  if (key === "session" && method === "GET") return json({ user: await getUser(request) });
  if (key === "auth/register" && method === "POST") {
    const input = await body(request, registrationSchema);
    const passwordHash = await hashPassword(input.password);
    const { user, token } = await transaction(async (client) => {
      const result = await client.query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email", [input.name, input.email, passwordHash]);
      return { user: result.rows[0], token: await createSession(client, result.rows[0].id) };
    });
    return json({ user }, 201, sessionCookie(token));
  }
  if (key === "auth/login" && method === "POST") {
    const input = await body(request, credentialsSchema);
    await limitLogin(input.email);
    const result = await pool.query("SELECT id,name,email,password_hash FROM users WHERE email=$1", [input.email]);
    const record = result.rows[0];
    if (!record) { await dummyPasswordWork(input.password); throw new ApiError(401, "Неверная почта или пароль"); }
    if (!await verifyPassword(input.password, record.password_hash)) throw new ApiError(401, "Неверная почта или пароль");
    const token = await transaction(async (client) => {
      await client.query("DELETE FROM auth_attempts WHERE key=$1", [tokenHash(input.email)]);
      return createSession(client, record.id);
    });
    return json({ user: { id: record.id, name: record.name, email: record.email } }, 200, sessionCookie(token));
  }
  if (key === "auth/logout" && method === "POST") {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash(token)]);
    return json({ ok: true }, 200, sessionCookie("", true));
  }
  const user = await requireUser(request);
  if (key === "projects") {
    if (method === "GET") {
      const result = await pool.query(`SELECT p.id,p.name,p.description,p.created_at AS "createdAt",m.role FROM projects p
        JOIN project_members m ON m.project_id=p.id WHERE m.user_id=$1 ORDER BY p.created_at DESC,p.id`, [user.id]);
      return json({ projects: result.rows });
    }
    if (method === "POST") {
      const input = await body(request, projectSchema);
      const project = await transaction((client) => createProject(client, user.id, input.name, input.description));
      return json({ project }, 201);
    }
  }
  if (key === "projects/demo" && method === "POST") {
    return json({ project: await transaction((client) => createDemo(client, user.id)) }, 201);
  }
  if (path[0] === "projects" && path.length >= 2) {
    const id = uuid(path[1]);
    if (path.length === 3 && path[2] === "worlds") {
      if (method === "GET") return transaction(async (client) => {
        await projectAccess(client, user.id, id);
        const result = await client.query('SELECT id,project_id AS "projectId",name,description FROM worlds WHERE project_id=$1 ORDER BY created_at,id', [id]);
        return json({ worlds: result.rows });
      });
      if (method === "POST") {
        const input = await body(request, worldSchema);
        return json({ world: await transaction((client) => createWorld(client, user.id, id, input.name, input.description)) }, 201);
      }
    }
    if (path.length === 2 && method === "PATCH") {
      const input = await body(request, projectPatch);
      if (!Object.keys(input).length) throw new ApiError(400, "Нет изменений для сохранения");
      return transaction(async (client) => {
        const before = await projectAccess(client, user.id, id, true);
        const updated = await client.query('UPDATE projects SET name=$1,description=$2 WHERE id=$3 RETURNING id,name,description,created_at AS "createdAt"', [input.name ?? before.name, input.description ?? before.description, id]);
        const project = { ...updated.rows[0], role: before.role };
        await audit(client, id, user.id, "project", id, "update", { before, after: project });
        return json({ project });
      });
    }
    if (path.length === 2 && method === "DELETE") return transaction(async (client) => {
      const before = await projectAccess(client, user.id, id, true, true);
      await audit(client, id, user.id, "project", id, "delete", { before });
      await client.query("DELETE FROM projects WHERE id=$1", [id]);
      return json({ ok: true });
    });
  }
  if (path[0] === "worlds" && path.length >= 2) {
    const id = uuid(path[1]);
    if (path.length === 2 && method === "GET") return json(await transaction((client) => loadWorld(client, user.id, id)));
    if (path.length === 2 && method === "PATCH") {
      const input = await body(request, projectPatch);
      if (!Object.keys(input).length) throw new ApiError(400, "Нет изменений для сохранения");
      return transaction(async (client) => {
        const before = await worldAccess(client, user.id, id, true);
        const result = await client.query('UPDATE worlds SET name=$1,description=$2 WHERE id=$3 RETURNING id,project_id AS "projectId",name,description', [input.name ?? before.name, input.description ?? before.description, id]);
        await audit(client, before.projectId, user.id, "world", id, "update", { before, after: result.rows[0] });
        return json({ world: result.rows[0] });
      });
    }
    if (path.length === 2 && method === "DELETE") return transaction(async (client) => {
      const world = await worldAccess(client, user.id, id, true);
      await audit(client, world.projectId, user.id, "world", id, "delete", { before: world });
      await client.query("DELETE FROM worlds WHERE id=$1", [id]);
      return json({ ok: true });
    });
    if (path.length === 3 && method === "POST") {
      const entity = path[2];
      if (entity === "characters" || entity === "events" || entity === "relations") {
        const schema = entity === "characters" ? characterSchema : entity === "events" ? eventSchema : relationSchema;
        const input = await body(request, schema as ZodType);
        const value = await transaction((client) => createEntity(client, user.id, id, entity, input));
        return json({ [entity === "characters" ? "character" : entity === "events" ? "event" : "relation"]: value }, 201);
      }
    }
  }
  if (path.length === 2 && (path[0] === "characters" || path[0] === "events" || path[0] === "relations")) {
    const table = path[0], id = uuid(path[1]);
    if (method === "DELETE") return json(await transaction((client) => mutateEntity(client, user.id, table, id, null)));
    if (method === "PATCH") {
      const schema = table === "characters" ? characterPatch : table === "events" ? eventPatch : relationPatch;
      const input = await body(request, schema);
      const value = await transaction((client) => mutateEntity(client, user.id, table, id, input));
      return json({ [table === "characters" ? "character" : table === "events" ? "event" : "relation"]: value });
    }
  }
  throw new ApiError(404, "Маршрут не найден");
}

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try { return await dispatch(request, (await context.params).path); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof ZodError) return json({ error: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, 400);
    const code = (error as { code?: string }).code;
    if (code === "23505") return json({ error: "Такая запись уже существует" }, 409);
    if (code === "23503") return json({ error: "Связанный объект удалён или недоступен. Обновите данные" }, 409);
    if (["ECONNREFUSED", "57P01", "57P03", "ENOTFOUND", "3D000", "42P01"].includes(code ?? "")) {
      console.error("Database unavailable:", code);
      return json({ error: "База данных недоступна. Проверьте запуск PostgreSQL и миграции" }, 503);
    }
    console.error("API operation failed", error instanceof Error ? error.name : "UnknownError", code ?? "");
    return json({ error: "Не удалось выполнить операцию. Повторите позже" }, 500);
  }
}
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
