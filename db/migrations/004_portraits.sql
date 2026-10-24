-- Lore Studio — ElpisHeart. Portraits live with world data in PostgreSQL,
-- so moving a ZIP checkout does not lose uploaded files.
ALTER TABLE lore_objects ADD COLUMN portrait_version integer NOT NULL DEFAULT 0 CHECK (portrait_version >= 0);

CREATE TABLE character_portraits (
  character_id uuid PRIMARY KEY,
  world_id uuid NOT NULL,
  content_type text NOT NULL CHECK (content_type = 'image/webp'),
  image_data bytea NOT NULL CHECK (octet_length(image_data) BETWEEN 1 AND 5242880),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 1200),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 1200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (character_id, world_id) REFERENCES lore_objects(id, world_id) ON DELETE CASCADE
);
CREATE INDEX character_portraits_world_idx ON character_portraits(world_id);
