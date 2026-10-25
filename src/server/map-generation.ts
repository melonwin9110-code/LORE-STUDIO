import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { MapBatchInput, MapData, MapFeatureInput } from "@/lib/map-types";
import { createMapBase } from "@/lib/map-generator";
import { worldAccess } from "./access";
import { ApiError } from "./errors";
import type { TemporalOptions } from "./history-validation";
import { mapCreateSchema } from "./map-validation";
import { createMap, saveMapContent } from "./maps";

export const mapGenerateSchema = mapCreateSchema.omit({ generation: true }).extend({
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#7fa5b2"),
  seed: z.string().trim().min(1).max(128).default(() => randomUUID()),
  preset: z.enum(["island", "continents", "archipelago"]).default("island"),
}).strict();

export async function createGeneratedMap(client: PoolClient, userId: string, worldId: string, input: z.output<typeof mapGenerateSchema>, options: TemporalOptions = {}): Promise<MapData> {
  const value = mapGenerateSchema.parse(input);
  // Authorize before doing generation. Existing map creation and batch saving
  // validate the temporal context and run in the caller's single transaction.
  await worldAccess(client, userId, worldId, true);
  const { seed, preset, ...settings } = value;
  const source = createMapBase({ seed, preset, width: value.width, height: value.height });
  if (source.layers.length + source.features.length + 2 > 200) throw new ApiError(400, "Слишком много объектов для основы карты");
  const created = await createMap(client, userId, worldId, {
    ...settings, generation: { seed, preset, algorithmVersion: source.algorithmVersion },
  }, options);
  const identities = new Map([...source.layers, ...source.features].map((item) => [item.id, randomUUID()]));
  const content: MapBatchInput = {
    expectedRevision: created.revision,
    layers: [
      ...created.layers.map((layer) => ({ op: "delete" as const, id: layer.id, version: layer.version })),
      ...source.layers.map(({ id, ...data }) => ({ op: "create" as const, id: identities.get(id)!, data })),
    ],
    features: source.features.map(({ id, ...data }) => {
      const layerId = identities.get(data.layerId);
      const parentId = data.parentId === null ? null : identities.get(data.parentId);
      if (!layerId || parentId === undefined) throw new ApiError(400, "Некорректные связи основы карты");
      return { op: "create" as const, id: identities.get(id)!, data: { ...data, layerId, parentId } satisfies MapFeatureInput };
    }),
  };
  return saveMapContent(client, userId, created.map.id, content, options);
}
