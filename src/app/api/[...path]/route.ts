import { NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { pool, transaction } from "@/server/db";
import { ApiError } from "@/server/errors";
import { createSession, dummyPasswordWork, getUser, hashPassword, limitLogin, requireUser, SESSION_COOKIE, sessionCookie, tokenHash, verifyPassword } from "@/server/auth";
import { characterPatch, characterSchema, credentialsSchema, eventPatch, eventSchema, idSchema, projectPatch, projectSchema, registrationSchema, relationPatch, relationSchema, worldSchema } from "@/server/validation";
import { audit, createEntity, createProject, createWorld, loadWorld, mutateEntity, projectAccess, worldAccess } from "@/server/repository";
import { createDemo } from "@/server/demo";
import { compareTimelines, createCalendar, createTimeline, listCalendars, listTimelines, objectHistory, transferObjects, updateTimeline } from "@/server/history";
import { calendarCreateSchema, daySchema, temporalOptions, timelineCreateSchema, timelinePatchSchema, transferSchema } from "@/server/history-validation";
import { getFamily, createFamilyEdge, updateFamilyEdge, deleteFamilyEdge, importFamily } from "@/server/family";
import { familyCreateSchema, familyPatchSchema, familyDeleteSchema, familyImportSchema } from "@/server/family-validation";
import { getPortrait, setPortrait, deletePortrait, MAX_PORTRAIT_BYTES } from "@/server/portraits";
import { listCharacterCatalog } from "@/server/catalog";
import { getTimelineGraph, saveTimelineGraph, timelineGraphSchema } from "@/server/timeline-graph";
import { listMaps, createMap, getMap, updateMap, deleteMap, saveMapContent, mergeMapGeometry, splitMapGeometry, mapFeatureHistory } from "@/server/maps";
import { mapCreateSchema, mapPatchSchema, mapDeleteSchema, mapBatchSchema, mapMergeSchema, mapSplitSchema } from "@/server/map-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const maxBody = 256 * 1024;

function json(value: unknown, status = 200, cookie?: string) {
  const response = NextResponse.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  if (cookie) response.headers.set("Set-Cookie", cookie);
  return response;
}
async function body<T>(request: NextRequest, schema: ZodType<T>, limit = maxBody): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Ожидается JSON");
  if (Number(request.headers.get("content-length")) > limit) throw new ApiError(413, "Слишком большой запрос");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Пустой запрос");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, "Слишком большой запрос"); }
    chunks.push(value);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Некорректный JSON"); }
  return schema.parse(data);
}
async function imageBody(request: NextRequest): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > MAX_PORTRAIT_BYTES) throw new ApiError(413, "Изображение должно быть не больше 5 МиБ");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Выберите изображение персонажа");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PORTRAIT_BYTES) { await reader.cancel(); throw new ApiError(413, "Изображение должно быть не больше 5 МиБ"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
    const required = ["001_initial.sql", "002_history.sql", "003_family_groups.sql", "004_portraits.sql", "005_timeline_graph.sql", "006_maps.sql"];
    const result = await pool.query("SELECT name FROM schema_migrations WHERE name=ANY($1::text[])", [required]);
    if (result.rowCount !== required.length) throw new ApiError(503, "Необходимо применить миграции");
    const database = await pool.query<{test_database:boolean}>("SELECT current_database() ~ '_test$' AS test_database");
    return json({ status: "ok", database: "connected", testDatabase: database.rows[0].test_database });
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
  if (method !== "GET" && request.nextUrl.searchParams.has("revision")) throw new ApiError(400, "Нельзя изменять зафиксированную редакцию");
  if (path[0] === "worlds" && path.length === 3 && path[2] === "maps") {
    const worldId = uuid(path[1]);
    const options = temporalOptions(request.nextUrl.searchParams, method !== "GET");
    if (method === "GET") return json(await transaction((client) => listMaps(client, user.id, worldId, options)));
    if (method === "POST") {
      const input = await body(request, mapCreateSchema);
      return json(await transaction((client) => createMap(client, user.id, worldId, input, options)), 201);
    }
  }
  if (path[0] === "maps" && path.length >= 2) {
    const id = uuid(path[1]);
    const options = temporalOptions(request.nextUrl.searchParams, method !== "GET");
    if (path.length === 2) {
      if (method === "GET") return json(await transaction((client) => getMap(client, user.id, id, options)));
      if (method === "PATCH") {
        const input = await body(request, mapPatchSchema);
        return json(await transaction((client) => updateMap(client, user.id, id, input, options)));
      }
      if (method === "DELETE") {
        const input = await body(request, mapDeleteSchema);
        return json(await transaction((client) => deleteMap(client, user.id, id, input.version, options)));
      }
    }
    if (path.length === 3 && path[2] === "content" && method === "PUT") {
      const input = await body(request, mapBatchSchema, 4 * 1024 * 1024);
      return json(await transaction((client) => saveMapContent(client, user.id, id, input, options)));
    }
    if (path.length === 4 && path[2] === "geometry" && method === "POST") {
      if (path[3] === "merge") {
        const input = await body(request, mapMergeSchema, 4 * 1024 * 1024);
        return json(await transaction((client) => mergeMapGeometry(client, user.id, id, input, options)));
      }
      if (path[3] === "split") {
        const input = await body(request, mapSplitSchema, 4 * 1024 * 1024);
        return json(await transaction((client) => splitMapGeometry(client, user.id, id, input, options)));
      }
    }
  }
  if (path[0] === "map-features" && path.length === 3 && path[2] === "history" && method === "GET") {
    const id = uuid(path[1]);
    return json(await transaction((client) => mapFeatureHistory(client, user.id, id, temporalOptions(request.nextUrl.searchParams))));
  }
  if (key === "characters/catalog" && method === "GET") {
    const search = request.nextUrl.searchParams;
    const rawLimit = search.get("limit");
    if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) throw new ApiError(400, "Некорректный размер страницы");
    return json(await transaction((client) => listCharacterCatalog(client, user.id, {
      query: search.get("q") ?? undefined, projectId: search.get("project") ?? undefined,
      worldId: search.get("world") ?? undefined, timelineId: search.get("timeline") ?? undefined,
      cursor: search.get("cursor") ?? undefined, limit: rawLimit === null ? undefined : Number(rawLimit),
    })));
  }
  if (path[0] === "characters" && path.length === 3 && path[2] === "portrait") {
    const id = uuid(path[1]);
    if (method === "GET") {
      const image = await transaction((client) => getPortrait(client, user.id, id));
      if (!image) throw new ApiError(404, "Портрет персонажа не найден");
      return new NextResponse(new Uint8Array(image.bytes), { headers: {
        "Content-Type": image.contentType, "Content-Length": String(image.bytes.byteLength),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": `inline; filename="${id}.webp"`,
      } });
    }
    if (method === "PUT") {
      const bytes = await imageBody(request);
      return json(await transaction((client) => setPortrait(client, user.id, id, bytes, request.headers.get("content-type") ?? "")));
    }
    if (method === "DELETE") return json(await transaction((client) => deletePortrait(client, user.id, id)));
  }
  if (path[0] === "worlds" && path.length >= 3) {
    const worldId = uuid(path[1]);
    if (path.length === 3 && path[2] === "family" && method === "GET") return json(await transaction((client) => getFamily(client, user.id, worldId)));
    if (path.length === 4 && path[2] === "family" && path[3] === "relations" && method === "POST") {
      const input = await body(request, familyCreateSchema);
      return json(await transaction((client) => createFamilyEdge(client, user.id, worldId, input)), 201);
    }
    if (path.length === 4 && path[2] === "family" && path[3] === "import" && method === "POST") {
      const input = await body(request, familyImportSchema);
      return json(await transaction((client) => importFamily(client, user.id, worldId, input)));
    }
    if (path.length === 3 && path[2] === "timeline-graph") {
      if (method === "GET") return json(await transaction((client) => getTimelineGraph(client, user.id, worldId)));
      if (method === "PUT") {
        const input = await body(request, timelineGraphSchema);
        return json(await transaction((client) => saveTimelineGraph(client, user.id, worldId, input)));
      }
    }
  }
  if (path[0] === "family" && path[1] === "relations" && path.length === 3) {
    const id = uuid(path[2]);
    if (method === "PATCH") {
      const input = await body(request, familyPatchSchema);
      return json(await transaction((client) => updateFamilyEdge(client, user.id, id, input)));
    }
    if (method === "DELETE") {
      const input = await body(request, familyDeleteSchema);
      return json(await transaction((client) => deleteFamilyEdge(client, user.id, id, input.expectedVersion)));
    }
  }
  if (path[0] === "timelines" && path.length >= 2) {
    const id = uuid(path[1]);
    if (path.length === 2 && method === "PATCH") {
      const input = await body(request, timelinePatchSchema);
      return json({ timeline: await transaction((client) => updateTimeline(client,user.id,id,input)) });
    }
    if (path.length === 3 && path[2] === "compare" && method === "GET") {
      const other = request.nextUrl.searchParams.get("other");
      if (!other) throw new ApiError(400,"Выберите линию для сравнения");
      const otherId = uuid(other);
      const day = request.nextUrl.searchParams.has("day") ? daySchema.parse(request.nextUrl.searchParams.get("day")) : undefined;
      return json(await transaction((client) => compareTimelines(client,user.id,id,otherId,day)));
    }
    if (path.length === 3 && path[2] === "transfer" && method === "POST") {
      const input = await body(request, transferSchema);
      return json(await transaction((client) => transferObjects(client,user.id,id,input)));
    }
  }
  if (path.length === 3 && path[2] === "history" && method === "GET" && (path[0] === "characters" || path[0] === "events" || path[0] === "relations")) {
    const kind = path[0], id = uuid(path[1]);
    return json({ revisions: await transaction((client) => objectHistory(client,user.id,kind,id,temporalOptions(request.nextUrl.searchParams))) });
  }
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
    if (path.length === 3 && path[2] === "timelines") {
      if (method === "GET") return json({ timelines: await transaction((client)=>listTimelines(client,user.id,id)) });
      if (method === "POST") {
        const input = await body(request,timelineCreateSchema);
        return json({ timeline: await transaction((client)=>createTimeline(client,user.id,id,input)) },201);
      }
    }
    if (path.length === 3 && path[2] === "calendars") {
      if (method === "GET") return json({ calendars: await transaction((client)=>listCalendars(client,user.id,id)) });
      if (method === "POST") {
        const input = await body(request,calendarCreateSchema);
        return json({ calendar: await transaction((client)=>createCalendar(client,user.id,id,input.definition)) },201);
      }
    }
    if (path.length === 2 && method === "GET") return json(await transaction((client) => loadWorld(client, user.id, id, temporalOptions(request.nextUrl.searchParams))));
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
        const value = await transaction((client) => createEntity(client, user.id, id, entity, input, temporalOptions(request.nextUrl.searchParams,true)));
        return json({ [entity === "characters" ? "character" : entity === "events" ? "event" : "relation"]: value }, 201);
      }
    }
  }
  if (path.length === 2 && (path[0] === "characters" || path[0] === "events" || path[0] === "relations")) {
    const table = path[0], id = uuid(path[1]);
    if (method === "DELETE") return json(await transaction((client) => mutateEntity(client, user.id, table, id, null, temporalOptions(request.nextUrl.searchParams,true))));
    if (method === "PATCH") {
      const schema = table === "characters" ? characterPatch : table === "events" ? eventPatch : relationPatch;
      const input = await body(request, schema);
      const value = await transaction((client) => mutateEntity(client, user.id, table, id, input, temporalOptions(request.nextUrl.searchParams,true)));
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
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE, handler as PUT };
