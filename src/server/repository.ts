import type { PoolClient } from "pg";
import type { Character, LoreEvent, Relation, WorldData } from "@/lib/types";
import { ApiError } from "./errors";
import { characterSchema, eventSchema, relationSchema } from "./validation";

type EntityTable = "characters" | "events" | "relations";
type EntityRow = { id: string; world_id: string; data: Record<string, unknown>; version: number; from_id?: string; to_id?: string };
type WorldContext = { id: string; projectId: string; name: string; description: string; role: string };
const editors = new Set(["owner", "admin", "editor"]);

export async function projectAccess(client: PoolClient, userId: string, id: string, write = false, owner = false) {
  const result = await client.query(`SELECT p.id,p.name,p.description,p.created_at AS "createdAt",m.role FROM projects p
    JOIN project_members m ON m.project_id=p.id AND m.user_id=$1 WHERE p.id=$2${write ? " FOR UPDATE OF p" : ""}`, [userId, id]);
  const project = result.rows[0];
  if (!project) throw new ApiError(404, "Проект не найден");
  if (write && !(owner ? project.role === "owner" : editors.has(project.role))) throw new ApiError(403, "Недостаточно прав");
  return project;
}
export async function worldAccess(client: PoolClient, userId: string, id: string, write = false): Promise<WorldContext> {
  // All writes lock parent project before world/entity, including cascaded
  // deletes. A uniform order avoids project-delete versus entity-update deadlocks.
  if (write) {
    const parent = await client.query<{ project_id: string }>("SELECT project_id FROM worlds WHERE id=$1", [id]);
    if (!parent.rows[0]) throw new ApiError(404, "Мир не найден");
    await projectAccess(client, userId, parent.rows[0].project_id, true);
  }
  const result = await client.query<WorldContext>(`SELECT w.id,w.project_id AS "projectId",w.name,w.description,m.role FROM worlds w
    JOIN project_members m ON m.project_id=w.project_id AND m.user_id=$1 WHERE w.id=$2${write ? " FOR UPDATE OF w" : ""}`, [userId, id]);
  const world = result.rows[0];
  if (!world) throw new ApiError(404, "Мир не найден");
  if (write && !editors.has(world.role)) throw new ApiError(403, "Недостаточно прав");
  return world;
}
export async function audit(client: PoolClient, projectId: string | null, userId: string, entityType: string, entityId: string, action: "create" | "update" | "delete", snapshot: unknown) {
  await client.query("INSERT INTO audit_log(project_id,actor_id,entity_type,entity_id,action,snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [projectId, userId, entityType, entityId, action, JSON.stringify(snapshot)]);
}
export async function createProject(client: PoolClient, userId: string, name: string, description: string, demo = false) {
  const result = await client.query(`INSERT INTO projects(owner_id,name,description,is_demo) VALUES($1,$2,$3,$4)
    RETURNING id,name,description,created_at AS "createdAt"`, [userId, name, description, demo]);
  const project = { ...result.rows[0], role: "owner" };
  await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [project.id, userId]);
  await audit(client, project.id, userId, "project", project.id, "create", { after: project });
  return project;
}
export async function createWorld(client: PoolClient, userId: string, projectId: string, name: string, description: string) {
  await projectAccess(client, userId, projectId, true);
  const result = await client.query('INSERT INTO worlds(project_id,name,description) VALUES($1,$2,$3) RETURNING id,project_id AS "projectId",name,description', [projectId, name, description]);
  await audit(client, projectId, userId, "world", result.rows[0].id, "create", { after: result.rows[0] });
  return result.rows[0];
}
async function participants(client: PoolClient, eventId: string): Promise<string[]> {
  const result = await client.query<{ character_id: string }>("SELECT character_id FROM event_participants WHERE event_id=$1 ORDER BY character_id", [eventId]);
  return result.rows.map((row) => row.character_id);
}
export async function mapEntity(client: PoolClient, table: EntityTable, row: EntityRow) {
  const value = { ...row.data, id: row.id, worldId: row.world_id, version: row.version };
  if (table === "events") return { ...value, characterIds: await participants(client, row.id) } as LoreEvent;
  if (table === "relations") return { ...value, fromId: row.from_id!, toId: row.to_id! } as Relation;
  return value as Character;
}
export async function loadWorld(client: PoolClient, userId: string, worldId: string): Promise<WorldData> {
  const context = await worldAccess(client, userId, worldId);
  const { role: _role, ...world } = context;
  void _role;
  const characters = await client.query<EntityRow>("SELECT * FROM characters WHERE world_id=$1 ORDER BY data->>'name',id", [worldId]);
  const events = await client.query<EntityRow>("SELECT * FROM events WHERE world_id=$1 ORDER BY (data->>'startYear')::bigint,data->>'name',id", [worldId]);
  const relations = await client.query<EntityRow>("SELECT * FROM relations WHERE world_id=$1 ORDER BY id", [worldId]);
  const mappedEvents: LoreEvent[] = [];
  // A transaction owns one pg client; do not queue concurrent queries on it.
  for (const row of events.rows) mappedEvents.push(await mapEntity(client, "events", row) as LoreEvent);
  return {
    world,
    characters: await Promise.all(characters.rows.map((row) => mapEntity(client, "characters", row))) as Character[],
    events: mappedEvents,
    relations: await Promise.all(relations.rows.map((row) => mapEntity(client, "relations", row))) as Relation[],
  };
}
async function validateLinks(client: PoolClient, worldId: string, ids: string[]) {
  if (!ids.length) return;
  const result = await client.query("SELECT id FROM characters WHERE world_id=$1 AND id=ANY($2::uuid[])", [worldId, [...new Set(ids)]]);
  if (result.rowCount !== new Set(ids).size) throw new ApiError(400, "Все персонажи должны принадлежать выбранному миру");
}
function parseEntity(table: EntityTable, input: unknown) {
  return table === "characters" ? characterSchema.parse(input) : table === "events" ? eventSchema.parse(input) : relationSchema.parse(input);
}
async function saveParticipants(client: PoolClient, eventId: string, worldId: string, ids: string[]) {
  await client.query("DELETE FROM event_participants WHERE event_id=$1", [eventId]);
  if (ids.length) await client.query("INSERT INTO event_participants(event_id,world_id,character_id) SELECT $1,$2,unnest($3::uuid[])", [eventId, worldId, ids]);
}
export async function createEntity(client: PoolClient, userId: string, worldId: string, table: EntityTable, input: unknown) {
  const world = await worldAccess(client, userId, worldId, true);
  const value = parseEntity(table, input) as Record<string, unknown>;
  let result;
  if (table === "relations") {
    const { fromId, toId, ...data } = value;
    await validateLinks(client, worldId, [fromId, toId] as string[]);
    result = await client.query<EntityRow>("INSERT INTO relations(world_id,from_id,to_id,data) VALUES($1,$2,$3,$4::jsonb) RETURNING *", [worldId, fromId, toId, JSON.stringify(data)]);
  } else {
    const { characterIds, ...data } = value;
    if (table === "events") await validateLinks(client, worldId, characterIds as string[]);
    result = await client.query<EntityRow>(`INSERT INTO ${table}(world_id,data) VALUES($1,$2::jsonb) RETURNING *`, [worldId, JSON.stringify(data)]);
    if (table === "events") await saveParticipants(client, result.rows[0].id, worldId, characterIds as string[]);
  }
  const entity = await mapEntity(client, table, result.rows[0]);
  await audit(client, world.projectId, userId, table, entity.id, "create", { after: entity });
  return entity;
}
export async function mutateEntity(client: PoolClient, userId: string, table: EntityTable, id: string, patch: Record<string, unknown> | null) {
  // First lookup only the world; permissions are checked before exposing entity content.
  const lookup = await client.query<{ world_id: string }>(`SELECT world_id FROM ${table} WHERE id=$1`, [id]);
  if (!lookup.rows[0]) throw new ApiError(404, "Объект не найден");
  const world = await worldAccess(client, userId, lookup.rows[0].world_id, true);
  const found = await client.query<EntityRow>(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
  const row = found.rows[0];
  if (!row) throw new ApiError(404, "Объект не найден");
  const before = await mapEntity(client, table, row);
  if (patch === null) {
    await audit(client, world.projectId, userId, table, id, "delete", { before });
    await client.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
    return { ok: true };
  }
  const { version, ...changes } = patch;
  if (!Object.keys(changes).length) throw new ApiError(400, "Нет изменений для сохранения");
  if (version !== row.version) throw new ApiError(409, "Объект изменён в другом окне. Обновите данные и повторите правку");
  const { id: _id, worldId: _worldId, version: _version, ...oldData } = before;
  void _id; void _worldId; void _version;
  const value = parseEntity(table, { ...oldData, ...changes }) as Record<string, unknown>;
  let updated;
  if (table === "relations") {
    const { fromId, toId, ...data } = value;
    await validateLinks(client, row.world_id, [fromId, toId] as string[]);
    updated = await client.query<EntityRow>("UPDATE relations SET data=$1::jsonb,from_id=$2,to_id=$3,version=version+1 WHERE id=$4 RETURNING *", [JSON.stringify(data), fromId, toId, id]);
  } else {
    const { characterIds, ...data } = value;
    if (table === "events") await validateLinks(client, row.world_id, characterIds as string[]);
    updated = await client.query<EntityRow>(`UPDATE ${table} SET data=$1::jsonb,version=version+1 WHERE id=$2 RETURNING *`, [JSON.stringify(data), id]);
    if (table === "events") await saveParticipants(client, id, row.world_id, characterIds as string[]);
  }
  const entity = await mapEntity(client, table, updated.rows[0]);
  await audit(client, world.projectId, userId, table, id, "update", { before, after: entity });
  return entity;
}
