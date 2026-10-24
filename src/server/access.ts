import type { PoolClient } from "pg";
import { ApiError } from "./errors";

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
