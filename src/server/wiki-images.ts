import sharp from "sharp";
import type { PoolClient } from "pg";
import type { WikiImage } from "@/lib/wiki-types";
import { audit, worldAccess } from "./access";
import { ApiError } from "./errors";

export const MAX_WIKI_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 20_000_000;
const MAX_INPUT_SIDE = 8192;
const MAX_OUTPUT_SIDE = 2048;
const imageFormats = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

/** Decode accepted raster formats and remove metadata by encoding a static WebP. */
async function prepareWikiImage(bytes: Buffer, contentType: string) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiError(400, "Выберите изображение для статьи");
  if (bytes.length > MAX_WIKI_IMAGE_BYTES) throw new ApiError(413, "Изображение должно быть не больше 5 МиБ");
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const expectedFormat = imageFormats.get(mediaType);
  if (!expectedFormat) throw new ApiError(415, "Для статьи подходят PNG, JPEG и WebP");
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat) throw new ApiError(400, "Содержимое файла не соответствует типу изображения");
    if (!metadata.width || !metadata.height || metadata.width > MAX_INPUT_SIDE || metadata.height > MAX_INPUT_SIDE ||
        metadata.width * metadata.height > MAX_INPUT_PIXELS || (metadata.pages ?? 1) > 1) {
      throw new ApiError(400, "Нужно статичное изображение не больше 8192 пикселей по стороне и 20 миллионов пикселей");
    }
    const converted = await image.rotate().resize({
      width: MAX_OUTPUT_SIDE, height: MAX_OUTPUT_SIDE, fit: "inside", withoutEnlargement: true,
    }).webp({ quality: 85, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (converted.data.length > MAX_WIKI_IMAGE_BYTES) throw new ApiError(413, "Не удалось уменьшить изображение до допустимого размера");
    return { bytes: converted.data, contentType: "image/webp", width: converted.info.width, height: converted.info.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Не удалось прочитать изображение. Выберите исправный PNG, JPEG или WebP");
  }
}

/**
 * Images are immutable world resources. Keeping old uploads preserves images in
 * historical article revisions; deleting a project/world removes them by cascade.
 */
export async function createWikiImage(client: PoolClient, userId: string, worldId: string, bytes: Buffer, contentType: string): Promise<WikiImage> {
  const world = await worldAccess(client, userId, worldId, true);
  const prepared = await prepareWikiImage(bytes, contentType);
  const created = await client.query<{ id: string }>(
    `INSERT INTO wiki_images(world_id,uploaded_by,content_type,bytes,width,height,byte_size)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [world.id, userId, prepared.contentType, prepared.bytes, prepared.width, prepared.height, prepared.bytes.length],
  );
  const id = created.rows[0].id;
  const result: WikiImage = { id, url: `/api/wiki-images/${id}`, width: prepared.width, height: prepared.height, bytes: prepared.bytes.length };
  await audit(client, world.projectId, userId, "wiki_image", id, "create", { after: result });
  return result;
}

/** Image URLs never grant access themselves; authorize current project membership. */
export async function getWikiImage(client: PoolClient, userId: string, imageId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const identity = await client.query<{ world_id: string }>("SELECT world_id FROM wiki_images WHERE id=$1", [imageId]);
  if (!identity.rows[0]) return null;
  await worldAccess(client, userId, identity.rows[0].world_id);
  const found = await client.query<{ bytes: Buffer; content_type: string }>(
    "SELECT bytes,content_type FROM wiki_images WHERE id=$1", [imageId],
  );
  const row = found.rows[0];
  return row ? { bytes: row.bytes, contentType: row.content_type } : null;
}
