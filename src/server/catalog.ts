import type { PoolClient } from "pg";
import { z } from "zod";
import type { Character } from "@/lib/types";
import type { CatalogEntry, CatalogResult, FamilyCharacter } from "@/lib/workspace-types";
import { worldAccess } from "./access";
import { ApiError } from "./errors";
import { withPortraits } from "./portraits";

type CatalogParams = { query?: string; projectId?: string; worldId?: string; timelineId?: string; cursor?: string; limit?: number };
type ProfileRow = {
  object_id: string; world_id: string; data: Record<string, unknown>; version: number;
  source_timeline_id: string; source_timeline_name: string; archived?: boolean;
};
type CatalogRow = ProfileRow & {
  project_id: string; project_name: string; project_role: string; world_name: string; total: string;
};

// Resolve every selected line from immutable revisions, preserving both parent
// revision pins and fork-day clipping. Root selection already enforces membership.
const frames = `WITH RECURSIVE roots AS (
  SELECT t.id AS root_id,t.world_id,t.name AS root_name,t.is_main,t.created_at AS root_created_at,
    w.project_id,w.name AS world_name,p.name AS project_name,m.role AS project_role
  FROM timelines t JOIN worlds w ON w.id=t.world_id JOIN projects p ON p.id=w.project_id
  JOIN project_members m ON m.project_id=p.id AND m.user_id=$1
  WHERE ($2::uuid IS NULL OR p.id=$2) AND ($3::uuid IS NULL OR w.id=$3) AND ($4::uuid IS NULL OR t.id=$4)
), lineage AS (
  SELECT r.root_id,t.id,t.world_id,t.parent_id,t.parent_revision,t.fork_day,
    t.head_revision AS cutoff,1000000000000000::bigint AS day,0 AS depth,ARRAY[t.id] AS path
  FROM roots r JOIN timelines t ON t.id=r.root_id
  UNION ALL
  SELECT c.root_id,p.id,p.world_id,p.parent_id,p.parent_revision,p.fork_day,
    c.parent_revision,LEAST(c.day,c.fork_day),c.depth+1,c.path||p.id
  FROM lineage c JOIN timelines p ON p.id=c.parent_id AND p.world_id=c.world_id
  WHERE NOT p.id=ANY(c.path)
), resolved AS (
  SELECT DISTINCT ON(c.root_id,r.object_id) c.root_id,r.object_id,r.world_id,r.data,r.version,r.deleted,
    r.revision,r.effective_day,c.depth
  FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id
  JOIN lore_objects o ON o.id=r.object_id AND o.world_id=r.world_id AND o.kind='characters'
  WHERE r.revision<=c.cutoff AND r.effective_day<=c.day
  ORDER BY c.root_id,r.object_id,c.depth,r.effective_day DESC,r.revision DESC
), live AS (
  SELECT f.*,r.root_name,r.is_main,r.root_created_at,r.project_id,r.project_name,r.project_role,r.world_name
  FROM resolved f JOIN roots r ON r.root_id=f.root_id WHERE NOT f.deleted
)`;

function toCharacter(row: ProfileRow): Character {
  return { ...row.data, id: row.object_id, worldId: row.world_id, version: row.version } as Character;
}

function filters(params: CatalogParams) {
  for (const id of [params.projectId, params.worldId, params.timelineId]) {
    if (id !== undefined && !z.uuid().safeParse(id).success) throw new ApiError(400, "Некорректный источник персонажей");
  }
  if (params.query !== undefined && (typeof params.query !== "string" || params.query.length > 200)) {
    throw new ApiError(400, "Поисковая строка должна быть не длиннее 200 символов");
  }
  const cursor = params.cursor ?? "0";
  if (!/^(0|[1-9]\d{0,6})$/.test(cursor) || Number(cursor) > 1_000_000) throw new ApiError(400, "Некорректная страница каталога");
  const limit = params.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "На странице может быть от 1 до 100 персонажей");
  return { offset: Number(cursor), limit, query: (params.query ?? "").trim() };
}

export async function listCharacterCatalog(client: PoolClient, userId: string, params: CatalogParams = {}): Promise<CatalogResult> {
  const options = filters(params);
  const found = await client.query<CatalogRow>(`${frames}, filtered AS (
    SELECT * FROM live WHERE $5::text='' OR
      strpos(lower(concat_ws(' ',data->>'name',data->>'title',data->>'species')),lower($5))>0
  ), page AS (
    SELECT object_id,world_id,data,version,root_id AS source_timeline_id,root_name AS source_timeline_name,
      project_id,project_name,project_role,world_name
    FROM filtered ORDER BY lower(data->>'name'),project_name,world_name,root_name,object_id,root_id LIMIT $6 OFFSET $7
  ), tally AS (SELECT count(*)::text AS total FROM filtered)
  SELECT p.*,t.total FROM tally t LEFT JOIN page p ON true`,
  [userId, params.projectId ?? null, params.worldId ?? null, params.timelineId ?? null, options.query, options.limit, options.offset]);
  const total = Number(found.rows[0]?.total ?? "0");
  const rows = found.rows.filter((row) => row.object_id !== null);
  const characters = await withPortraits(client, rows.map(toCharacter));
  const entries: CatalogEntry[] = rows.map((row, index) => ({
    key: `${row.object_id}:${row.source_timeline_id}`, character: characters[index],
    project: { id: row.project_id, name: row.project_name, role: row.project_role },
    world: { id: row.world_id, name: row.world_name },
    timeline: { id: row.source_timeline_id, name: row.source_timeline_name },
  }));
  return { characters: entries, total, nextCursor: options.offset + rows.length < total ? String(options.offset + rows.length) : null };
}

/** Stable representatives for a world-level family: temporal deletion does not erase ancestry. */
export async function getWorldCharacters(client: PoolClient, userId: string, worldId: string): Promise<FamilyCharacter[]> {
  await worldAccess(client, userId, worldId);
  const found = await client.query<ProfileRow>(`${frames}, current_profiles AS (
    SELECT DISTINCT ON(object_id) object_id,world_id,data,version,
      root_id AS source_timeline_id,root_name AS source_timeline_name,false AS archived
    FROM live ORDER BY object_id,is_main DESC,root_created_at,root_id
  ), historical_profiles AS (
    SELECT DISTINCT ON(o.id) o.id AS object_id,o.world_id,r.data,r.version,
      r.timeline_id AS source_timeline_id,t.name AS source_timeline_name,true AS archived
    FROM lore_objects o JOIN lore_revisions r ON r.object_id=o.id AND r.world_id=o.world_id AND NOT r.deleted
    JOIN timelines t ON t.id=r.timeline_id AND t.world_id=o.world_id
    WHERE o.world_id=$3 AND o.kind='characters'
    ORDER BY o.id,r.revision DESC
  ), profiles AS (
    SELECT * FROM current_profiles
    UNION ALL SELECT h.* FROM historical_profiles h WHERE NOT EXISTS(SELECT 1 FROM current_profiles c WHERE c.object_id=h.object_id)
  ) SELECT * FROM profiles ORDER BY lower(data->>'name'),object_id`, [userId, null, worldId, null]);
  const representatives = found.rows.map((row): FamilyCharacter => ({
    ...toCharacter(row), sourceTimelineId: row.source_timeline_id, sourceTimelineName: row.source_timeline_name,
    ...(row.archived ? { archived: true } : {}),
  }));
  return withPortraits(client, representatives);
}
