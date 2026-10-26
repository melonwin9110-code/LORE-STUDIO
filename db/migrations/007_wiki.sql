-- Lore Studio — ElpisHeart. Author-written articles share immutable lore pins.
ALTER TABLE lore_objects DROP CONSTRAINT lore_objects_kind_check;
ALTER TABLE lore_objects ADD CONSTRAINT lore_objects_kind_check
  CHECK (kind IN ('characters','events','relations','maps','map_layers','map_features','wiki_articles'));

-- Images are immutable resources retained by every historical article version.
CREATE TABLE wiki_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  content_type text NOT NULL CHECK (content_type='image/webp'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  byte_size integer NOT NULL CHECK (byte_size=octet_length(bytes)),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (width::bigint*height<=20000000)
);
CREATE INDEX wiki_images_world_idx ON wiki_images(world_id);

CREATE FUNCTION protect_wiki_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM worlds WHERE id=OLD.world_id) THEN
      RAISE EXCEPTION 'Wiki images are immutable historical resources';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.world_id,NEW.content_type,NEW.bytes,NEW.width,NEW.height,NEW.byte_size,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.world_id,OLD.content_type,OLD.bytes,OLD.width,OLD.height,OLD.byte_size,OLD.created_at)
      OR (NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by AND NEW.uploaded_by IS NOT NULL) THEN
    RAISE EXCEPTION 'Wiki image contents are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wiki_images_immutable BEFORE UPDATE OR DELETE ON wiki_images
  FOR EACH ROW EXECUTE FUNCTION protect_wiki_image();

-- The payload is never rewritten: search selects the pinned current state first.
CREATE INDEX lore_revisions_wiki_text_idx ON lore_revisions USING gin (
  to_tsvector('russian',coalesce(data->>'searchText',''))
) WHERE NOT deleted AND data ? 'searchText';
