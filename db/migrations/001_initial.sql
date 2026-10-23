-- Lore Studio, author: ElpisHeart. World dates are signed integer years, never timestamps.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE TABLE auth_attempts (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_demo_owner_idx ON projects(owner_id) WHERE is_demo;
CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'reader', 'guest')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);
CREATE TABLE worlds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worlds_project_idx ON worlds(project_id);
CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, world_id)
);
CREATE INDEX characters_world_idx ON characters(world_id);
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, world_id)
);
CREATE INDEX events_world_idx ON events(world_id);
CREATE TABLE event_participants (
  event_id uuid NOT NULL,
  character_id uuid NOT NULL,
  world_id uuid NOT NULL,
  PRIMARY KEY (event_id, character_id),
  FOREIGN KEY (event_id, world_id) REFERENCES events(id, world_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id, world_id) REFERENCES characters(id, world_id) ON DELETE CASCADE
);
CREATE INDEX event_participants_character_idx ON event_participants(character_id);
CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (from_id <> to_id),
  FOREIGN KEY (from_id, world_id) REFERENCES characters(id, world_id) ON DELETE CASCADE,
  FOREIGN KEY (to_id, world_id) REFERENCES characters(id, world_id) ON DELETE CASCADE
);
CREATE INDEX relations_world_idx ON relations(world_id);
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_project_idx ON audit_log(project_id, id);
