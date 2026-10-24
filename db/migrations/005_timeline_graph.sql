-- Lore Studio — ElpisHeart. Layout and story connections do not alter ancestry.
CREATE TABLE timeline_graph_state (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  positions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(positions) = 'object'),
  viewport jsonb NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}'::jsonb CHECK (jsonb_typeof(viewport) = 'object'),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE timeline_connections (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('intersection','influence','travel')),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 160),
  CHECK (source_id <> target_id),
  FOREIGN KEY (source_id, world_id) REFERENCES timelines(id, world_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id, world_id) REFERENCES timelines(id, world_id) ON DELETE CASCADE
);
CREATE INDEX timeline_connections_world_idx ON timeline_connections(world_id);
INSERT INTO timeline_graph_state(world_id) SELECT id FROM worlds;
