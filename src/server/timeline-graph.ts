import type { PoolClient } from "pg";
import { z } from "zod";
import type { TimelineConnection, TimelineGraph } from "@/lib/workspace-types";
import { audit, worldAccess } from "./access";
import { ApiError } from "./errors";

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const positionSchema = z.object({ x: coordinate, y: coordinate }).strict();
const connectionSchema = z.object({
  id: z.uuid(), sourceId: z.uuid(), targetId: z.uuid(),
  kind: z.enum(["intersection", "influence", "travel"]),
  label: z.string().trim().max(160),
}).strict().refine((value) => value.sourceId !== value.targetId, "Связь должна соединять разные временные линии");

export const timelineGraphSchema = z.object({
  version: z.number().int().min(0).max(2_147_483_646),
  positions: z.record(z.uuid(), positionSchema).refine((value) => Object.keys(value).length <= 5000, "Слишком много позиций на схеме"),
  viewport: z.object({ x: coordinate, y: coordinate, zoom: z.number().finite().min(0.1).max(3) }).strict(),
  connections: z.array(connectionSchema).max(2000),
}).strict().refine((value) => new Set(value.connections.map((item) => item.id)).size === value.connections.length, "Идентификаторы переплетений не должны повторяться");

const emptyGraph = (): TimelineGraph => ({ version: 0, positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, connections: [] });

async function readGraph(client: PoolClient, worldId: string): Promise<TimelineGraph> {
  // State and connections are read in one statement so the version describes
  // exactly the same committed snapshot as the returned positions and edges.
  const result = await client.query<TimelineGraph>(`SELECT s.version,s.positions,s.viewport,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'sourceId',c.source_id,'targetId',c.target_id,'kind',c.kind,'label',c.label) ORDER BY c.id)
      FROM timeline_connections c WHERE c.world_id=s.world_id),'[]'::jsonb) AS connections
    FROM timeline_graph_state s WHERE s.world_id=$1`, [worldId]);
  return result.rows[0] ?? emptyGraph();
}

export async function getTimelineGraph(client: PoolClient, userId: string, worldId: string): Promise<TimelineGraph> {
  await worldAccess(client, userId, worldId);
  return readGraph(client, worldId);
}

export async function saveTimelineGraph(client: PoolClient, userId: string, worldId: string, input: TimelineGraph): Promise<TimelineGraph> {
  const value = timelineGraphSchema.parse(input);
  const world = await worldAccess(client, userId, worldId, true);
  const current = await client.query<{ version: number }>("SELECT version FROM timeline_graph_state WHERE world_id=$1 FOR UPDATE", [worldId]);
  if ((current.rows[0]?.version ?? 0) !== value.version) {
    throw new ApiError(409, "Схема изменена в другом окне. Перечитайте схему перед сохранением");
  }
  const lines = await client.query<{ id: string }>("SELECT id FROM timelines WHERE world_id=$1", [worldId]);
  const known = new Set(lines.rows.map((line) => line.id));
  if (Object.keys(value.positions).some((id) => !known.has(id)) || value.connections.some((edge) => !known.has(edge.sourceId) || !known.has(edge.targetId))) {
    throw new ApiError(400, "Элементы схемы должны принадлежать этому миру");
  }
  const before = await readGraph(client, worldId);
  await client.query(`INSERT INTO timeline_graph_state(world_id,version,positions,viewport,updated_by)
    VALUES($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT(world_id) DO UPDATE SET
    version=EXCLUDED.version,positions=EXCLUDED.positions,viewport=EXCLUDED.viewport,updated_by=EXCLUDED.updated_by,updated_at=now()`,
  [worldId, value.version + 1, JSON.stringify(value.positions), JSON.stringify(value.viewport), userId]);
  await client.query("DELETE FROM timeline_connections WHERE world_id=$1", [worldId]);
  for (const edge of value.connections) {
    await client.query("INSERT INTO timeline_connections(id,world_id,source_id,target_id,kind,label) VALUES($1,$2,$3,$4,$5,$6)",
      [edge.id, worldId, edge.sourceId, edge.targetId, edge.kind, edge.label]);
  }
  const after = { ...value, version: value.version + 1, connections: value.connections as TimelineConnection[] };
  await audit(client, world.projectId, userId, "timeline_graph", worldId, "update", { before, after });
  return after;
}
