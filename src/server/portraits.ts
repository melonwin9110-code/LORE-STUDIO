import sharp from "sharp";
import type { PoolClient } from "pg";
import type { Character } from "@/lib/types";
import { audit, worldAccess } from "./access";
import { ApiError } from "./errors";

export const MAX_PORTRAIT_BYTES = 5 * 1024 * 1024;
export const MAX_PORTRAIT_PIXELS = 20_000_000;
const MAX_INPUT_SIDE = 8192;
const types = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

async function characterScope(client: PoolClient, userId: string, characterId: string, write = false) {
  const found = await client.query<{ world_id: string }>(
    "SELECT world_id FROM lore_objects WHERE id=$1 AND kind='characters'",
    [characterId],
  );
  if (!found.rows[0]) throw new ApiError(404, "Персонаж не найден");
  return worldAccess(client, userId, found.rows[0].world_id, write);
}

/** Decode every accepted image and produce a small metadata-free static WebP. */
export async function preparePortrait(bytes: Buffer, contentType: string) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiError(400, "Выберите изображение персонажа");
  if (bytes.length > MAX_PORTRAIT_BYTES) throw new ApiError(413, "Изображение должно быть не больше 5 МиБ");
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const expectedFormat = types.get(mediaType);
  if (!expectedFormat) throw new ApiError(415, "Для портрета подходят PNG, JPEG и WebP");
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_PORTRAIT_PIXELS, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat) throw new ApiError(400, "Содержимое файла не соответствует типу изображения");
    if (!metadata.width || !metadata.height || metadata.width > MAX_INPUT_SIDE || metadata.height > MAX_INPUT_SIDE ||
        metadata.width * metadata.height > MAX_PORTRAIT_PIXELS || (metadata.pages ?? 1) > 1) {
      throw new ApiError(400, "Нужен статичный портрет не больше 8192 пикселей по стороне и 20 миллионов пикселей");
    }
    const converted = await image.rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (converted.data.length > MAX_PORTRAIT_BYTES) throw new ApiError(413, "Не удалось уменьшить изображение до допустимого размера");
    return { bytes: converted.data, contentType: "image/webp", width: converted.info.width, height: converted.info.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Не удалось прочитать изображение. Выберите исправный PNG, JPEG или WebP");
  }
}

export async function setPortrait(client: PoolClient, userId: string, characterId: string, bytes: Buffer, contentType: string) {
  const world = await characterScope(client, userId, characterId, true);
  const prepared = await preparePortrait(bytes, contentType);
  await client.query(`INSERT INTO character_portraits(character_id,world_id,content_type,image_data,width,height)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(character_id) DO UPDATE SET
    content_type=EXCLUDED.content_type,image_data=EXCLUDED.image_data,width=EXCLUDED.width,height=EXCLUDED.height,updated_at=now()`,
  [characterId, world.id, prepared.contentType, prepared.bytes, prepared.width, prepared.height]);
  const counter = await client.query<{ portrait_version: number }>(
    "UPDATE lore_objects SET portrait_version=portrait_version+1 WHERE id=$1 RETURNING portrait_version", [characterId],
  );
  const portraitUrl = `/api/characters/${characterId}/portrait?v=${counter.rows[0].portrait_version}`;
  await audit(client, world.projectId, userId, "portrait", characterId, "update", {
    after: { portraitUrl, contentType: prepared.contentType, width: prepared.width, height: prepared.height },
  });
  return { portraitUrl };
}

export async function getPortrait(client: PoolClient, userId: string, characterId: string) {
  await characterScope(client, userId, characterId);
  const found = await client.query<{ image_data: Buffer; content_type: string }>(
    "SELECT image_data,content_type FROM character_portraits WHERE character_id=$1", [characterId],
  );
  const row = found.rows[0];
  return row ? { bytes: row.image_data, contentType: row.content_type } : null;
}

export async function deletePortrait(client: PoolClient, userId: string, characterId: string) {
  const world = await characterScope(client, userId, characterId, true);
  const removed = await client.query("DELETE FROM character_portraits WHERE character_id=$1", [characterId]);
  if (removed.rowCount) {
    await client.query("UPDATE lore_objects SET portrait_version=portrait_version+1 WHERE id=$1", [characterId]);
    await audit(client, world.projectId, userId, "portrait", characterId, "delete", { before: { characterId } });
  }
  return { ok: true };
}

/** Call after authorizing the supplied character records; never fetch image bytes for lists. */
export async function withPortraits<T extends Character>(client: PoolClient, characters: T[]): Promise<T[]> {
  if (!characters.length) return [];
  const found = await client.query<{ character_id: string; portrait_version: number }>(
    `SELECT p.character_id,o.portrait_version FROM character_portraits p JOIN lore_objects o ON o.id=p.character_id
     WHERE p.character_id=ANY($1::uuid[])`, [[...new Set(characters.map((character) => character.id))]],
  );
  const versions = new Map(found.rows.map((row) => [row.character_id, row.portrait_version]));
  return characters.map((character) => ({ ...character, portraitUrl: versions.has(character.id)
    ? `/api/characters/${character.id}/portrait?v=${versions.get(character.id)}` : null }));
}
