import type { PoolClient } from "pg";
import { audit, projectAccess } from "./access";
import { initializeWorld } from "./history";
export { audit, projectAccess, worldAccess } from "./access";
export { loadWorld, createEntity, mutateEntity } from "./history";

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
  await initializeWorld(client, result.rows[0].id);
  return result.rows[0];
}
