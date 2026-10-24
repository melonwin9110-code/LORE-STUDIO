-- Lore Studio — ElpisHeart. Existing stage-1 data becomes one known baseline,
-- not an invented reconstruction of its historical states.
CREATE TABLE timelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  parent_id uuid,
  parent_revision bigint,
  fork_day bigint,
  head_revision bigint NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
  is_main boolean NOT NULL DEFAULT false,
  is_canon boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, world_id),
  FOREIGN KEY (parent_id, world_id) REFERENCES timelines(id, world_id),
  CHECK (parent_id IS NULL AND parent_revision IS NULL AND fork_day IS NULL OR parent_id IS NOT NULL AND parent_revision IS NOT NULL AND fork_day IS NOT NULL AND parent_revision >= 0 AND fork_day BETWEEN -1000000000000000 AND 1000000000000000),
  CHECK (NOT is_main OR parent_id IS NULL),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX timelines_main_idx ON timelines(world_id) WHERE is_main;
CREATE INDEX timelines_world_idx ON timelines(world_id);
CREATE TABLE world_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX world_calendars_default_idx ON world_calendars(world_id) WHERE is_default;
CREATE INDEX world_calendars_world_idx ON world_calendars(world_id);
CREATE TABLE lore_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('characters','events','relations')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (id, world_id)
);
CREATE INDEX lore_objects_world_idx ON lore_objects(world_id);
CREATE TABLE lore_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_id uuid NOT NULL,
  world_id uuid NOT NULL,
  timeline_id uuid NOT NULL,
  effective_day bigint NOT NULL CHECK (effective_day BETWEEN -1000000000000000 AND 1000000000000000),
  version integer NOT NULL CHECK (version > 0),
  deleted boolean NOT NULL DEFAULT false,
  data jsonb,
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id,version),
  FOREIGN KEY (object_id,world_id) REFERENCES lore_objects(id,world_id) ON DELETE CASCADE,
  FOREIGN KEY (timeline_id,world_id) REFERENCES timelines(id,world_id) ON DELETE CASCADE,
  CHECK (deleted AND data IS NULL OR NOT deleted AND data IS NOT NULL AND jsonb_typeof(data) = 'object')
);
CREATE INDEX lore_revisions_snapshot_idx ON lore_revisions(timeline_id, object_id, effective_day DESC, revision DESC);
CREATE INDEX lore_revisions_history_idx ON lore_revisions(object_id, revision DESC);

INSERT INTO timelines(world_id,name,is_main,is_canon) SELECT id,'Основная история',true,true FROM worlds;
INSERT INTO world_calendars(world_id,definition,is_default)
SELECT id,'{"name":"Григорианский","months":[{"name":"Январь","days":31},{"name":"Февраль","days":28},{"name":"Март","days":31},{"name":"Апрель","days":30},{"name":"Май","days":31},{"name":"Июнь","days":30},{"name":"Июль","days":31},{"name":"Август","days":31},{"name":"Сентябрь","days":30},{"name":"Октябрь","days":31},{"name":"Ноябрь","days":30},{"name":"Декабрь","days":31}],"leap":{"every":4,"exceptEvery":100,"includeEvery":400,"month":2,"days":1,"offset":0},"epochOffset":"0","era":"г."}'::jsonb,true FROM worlds;
INSERT INTO lore_objects(id,world_id,kind,version)
SELECT id,world_id,'characters',version FROM characters UNION ALL
SELECT id,world_id,'events',version FROM events UNION ALL
SELECT id,world_id,'relations',version FROM relations;
INSERT INTO lore_revisions(object_id,world_id,timeline_id,effective_day,version,data,actor_id)
SELECT o.id,o.world_id,t.id,-1000000000000000,o.version,baseline.data,p.owner_id FROM lore_objects o
JOIN timelines t ON t.world_id=o.world_id AND t.is_main
JOIN worlds w ON w.id=o.world_id JOIN projects p ON p.id=w.project_id
JOIN (
 SELECT id,data FROM characters
 UNION ALL SELECT e.id,e.data || jsonb_build_object('characterIds',COALESCE((SELECT jsonb_agg(ep.character_id ORDER BY ep.character_id) FROM event_participants ep WHERE ep.event_id=e.id),'[]'::jsonb)) FROM events e
 UNION ALL SELECT r.id,r.data || jsonb_build_object('fromId',r.from_id,'toId',r.to_id,'familyKind','other') FROM relations r
) baseline ON baseline.id=o.id;
UPDATE timelines t SET head_revision=COALESCE((SELECT max(revision) FROM lore_revisions r WHERE r.timeline_id=t.id),0);

CREATE FUNCTION protect_lore_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS(SELECT 1 FROM worlds WHERE id=OLD.world_id) THEN
    RAISE EXCEPTION 'Lore revisions are immutable; append a new revision instead';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER lore_revisions_immutable BEFORE UPDATE OR DELETE ON lore_revisions FOR EACH ROW EXECUTE FUNCTION protect_lore_revision();
CREATE FUNCTION protect_timeline_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.world_id,NEW.parent_id,NEW.parent_revision,NEW.fork_day,NEW.is_main) IS DISTINCT FROM ROW(OLD.world_id,OLD.parent_id,OLD.parent_revision,OLD.fork_day,OLD.is_main) THEN
    RAISE EXCEPTION 'Timeline ancestry and fork snapshot are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER timeline_lineage_immutable BEFORE UPDATE ON timelines FOR EACH ROW EXECUTE FUNCTION protect_timeline_lineage();
