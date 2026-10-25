-- Lore Studio — ElpisHeart. Map facts share immutable lore revision pins.
ALTER TABLE lore_objects DROP CONSTRAINT lore_objects_kind_check;
ALTER TABLE lore_objects ADD CONSTRAINT lore_objects_kind_check
  CHECK (kind IN ('characters','events','relations','maps','map_layers','map_features'));

-- Fictional map coordinates use a local Cartesian plane, not Earth longitude.
-- Geometry is kept with each immutable revision, never overwritten in place.
ALTER TABLE lore_revisions ADD COLUMN geometry geometry(Geometry,0);
-- Keep SRID and dimension checks simple: PostGIS metadata helpers inspect them.
ALTER TABLE lore_revisions ADD CONSTRAINT lore_revision_geometry_srid
  CHECK (ST_SRID(geometry)=0);
ALTER TABLE lore_revisions ADD CONSTRAINT lore_revision_geometry_dims
  CHECK (ST_NDims(geometry)=2);
ALTER TABLE lore_revisions ADD CONSTRAINT lore_revision_geometry_valid CHECK (
  geometry IS NULL OR (
    NOT deleted AND NOT ST_IsEmpty(geometry) AND ST_IsValid(geometry)
    -- An IN/=ANY geometry-type check makes PostGIS infer only its first type.
    AND array_position(ARRAY['POINT','LINESTRING','POLYGON','MULTIPOLYGON'],GeometryType(geometry)) IS NOT NULL
  )
);
CREATE INDEX lore_revisions_geometry_idx ON lore_revisions USING gist(geometry)
  WHERE geometry IS NOT NULL;

CREATE FUNCTION check_map_revision_geometry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object_kind text;
BEGIN
  SELECT kind INTO object_kind FROM lore_objects WHERE id=NEW.object_id AND world_id=NEW.world_id;
  IF object_kind='map_features' AND NOT NEW.deleted THEN
    IF NEW.geometry IS NULL OR NEW.data->'geometry' IS NULL THEN
      RAISE EXCEPTION 'Map feature revisions require a geometry' USING ERRCODE='23514';
    END IF;
    IF NOT ST_Equals(NEW.geometry,ST_SetSRID(ST_GeomFromGeoJSON(NEW.data->'geometry'),0)) THEN
      RAISE EXCEPTION 'Map feature payload and stored geometry differ' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.geometry IS NOT NULL THEN
    RAISE EXCEPTION 'Only live map feature revisions may have geometry' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lore_map_geometry BEFORE INSERT ON lore_revisions
  FOR EACH ROW EXECUTE FUNCTION check_map_revision_geometry();
