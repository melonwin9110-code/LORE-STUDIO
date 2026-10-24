-- Lore Studio — ElpisHeart. Independent world family links preserve legacy facts.
CREATE TABLE world_family_state (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK(version >= 0),
  initialized boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE family_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  family_kind text NOT NULL CHECK(family_kind IN ('parent','adoptive_parent','spouse')),
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  source_relation_id uuid,
  CHECK(from_id <> to_id),
  FOREIGN KEY(from_id,world_id) REFERENCES lore_objects(id,world_id) ON DELETE CASCADE,
  FOREIGN KEY(to_id,world_id) REFERENCES lore_objects(id,world_id) ON DELETE CASCADE
);
CREATE INDEX family_relations_world_idx ON family_relations(world_id);
CREATE TABLE family_legacy_sources (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  timeline_id uuid NOT NULL,
  timeline_name text NOT NULL,
  source_revision bigint NOT NULL,
  relations jsonb NOT NULL CHECK(jsonb_typeof(relations)='array'),
  PRIMARY KEY(world_id,timeline_id),
  FOREIGN KEY(timeline_id,world_id) REFERENCES timelines(id,world_id) ON DELETE CASCADE
);
INSERT INTO world_family_state(world_id,initialized) SELECT id,false FROM worlds;

-- Freeze every line's visible family at the migration, including an empty line
-- when another line disagrees. The old revisions and their pins remain intact.
WITH RECURSIVE lineage AS (
  SELECT t.id AS source_id,t.world_id,t.id,t.parent_id,t.parent_revision,t.fork_day,
    t.head_revision AS cutoff,1000000000000000::bigint AS day,0 AS depth,ARRAY[t.id] AS path
  FROM timelines t
  UNION ALL
  SELECT c.source_id,c.world_id,p.id,p.parent_id,p.parent_revision,p.fork_day,
    c.parent_revision,LEAST(c.day,c.fork_day),c.depth+1,c.path||p.id
  FROM lineage c JOIN timelines p ON p.id=c.parent_id AND p.world_id=c.world_id
  WHERE NOT p.id=ANY(c.path)
), ranked AS (
  SELECT DISTINCT ON(c.source_id,r.object_id) c.source_id,c.world_id,r.object_id,r.version,r.deleted,r.data,o.kind
  FROM lineage c JOIN lore_revisions r ON r.timeline_id=c.id AND r.world_id=c.world_id AND r.revision<=c.cutoff AND r.effective_day<=c.day
  JOIN lore_objects o ON o.id=r.object_id AND o.world_id=r.world_id
  ORDER BY c.source_id,r.object_id,c.depth,r.effective_day DESC,r.revision DESC
), snapshots AS (
  SELECT t.world_id,t.id,t.name,t.head_revision,
    COALESCE(jsonb_agg(r.data||jsonb_build_object('id',r.object_id,'version',r.version) ORDER BY r.object_id)
      FILTER(WHERE r.kind='relations' AND NOT r.deleted AND r.data->>'familyKind' IN ('parent','adoptive_parent','spouse')),'[]'::jsonb) AS relations
  FROM timelines t LEFT JOIN ranked r ON r.source_id=t.id
  GROUP BY t.world_id,t.id,t.name,t.head_revision
), affected AS (
  SELECT DISTINCT world_id FROM snapshots WHERE jsonb_array_length(relations)>0
)
INSERT INTO family_legacy_sources(world_id,timeline_id,timeline_name,source_revision,relations)
SELECT s.world_id,s.id,s.name,s.head_revision,s.relations FROM snapshots s JOIN affected a ON a.world_id=s.world_id;
UPDATE world_family_state s SET initialized=true WHERE NOT EXISTS(SELECT 1 FROM family_legacy_sources l WHERE l.world_id=s.world_id);
