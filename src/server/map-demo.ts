import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { GeographyKind, MapFeatureInput, MapGeometry } from "@/lib/map-types";
import { createMap, saveMapContent } from "./maps";

/** Hand-authored geography for each new private demo, not a generation engine. */
export async function createDemoAtlas(client: PoolClient, userId: string, worldId: string, treatyId: string, expeditionId: string) {
  const atlas = await createMap(client, userId, worldId, {
    name: "Земли Элирии", description: "Серебряное море, леса хранителей и северные королевства. Каждый объект можно изменить.",
    width: 1000, height: 700, background: "#173949",
  });
  const physical = atlas.layers.find((layer) => layer.kind === "physical")!;
  const political = atlas.layers.find((layer) => layer.kind === "political")!;
  const polygon = (points: [number, number][]): MapGeometry => ({ type: "Polygon", coordinates: [[...points, points[0]]] });
  const land = polygon([[100, 185], [165, 380], [140, 470], [280, 560], [430, 590], [565, 535], [760, 535], [865, 420], [800, 320], [850, 235], [675, 120], [470, 145], [310, 95], [180, 120]]);
  const northId = randomUUID();
  function feature(name: string, kind: GeographyKind, geometry: MapGeometry, fill: string, extra: Partial<MapFeatureInput> = {}) {
    return {
      op: "create" as const, id: randomUUID(), data: {
        name, kind, geometry, layerId: physical.id, description: "", fill, stroke: fill, strokeWidth: 1.7,
        label: true, eventId: null, parentId: null, ...extra,
      } satisfies MapFeatureInput,
    };
  }
  const north = feature("Северное королевство", "state", polygon([[270, 420], [300, 535], [430, 565], [565, 510], [750, 505], [790, 425], [610, 350], [460, 390]]), "#a585bc", { layerId: political.id, eventId: treatyId });
  north.id = northId;
  await saveMapContent(client, userId, atlas.map.id, {
    expectedRevision: atlas.revision,
    layers: [{ op: "update", id: political.id, version: political.version, data: { name: political.name, kind: political.kind, visible: true, locked: false, opacity: 0.38, order: political.order } }],
    features: [
      feature("Элирия", "continent", land, "#92a78c", { stroke: "#c4d0ad", strokeWidth: 2.5, label: false }),
      feature("Остров двух лун", "island", polygon([[790, 80], [850, 110], [895, 80], [865, 45], [815, 40]]), "#b3ba92"),
      feature("Серебряный лес", "forest", polygon([[205, 250], [245, 380], [350, 415], [425, 350], [390, 240], [295, 205]]), "#4f7964", { stroke: "#86a68c", eventId: treatyId }),
      feature("Хребет Рассвета", "mountain", { type: "LineString", coordinates: [[470, 510], [510, 465], [555, 495], [600, 440], [650, 465], [700, 410]] }, "#b9b6a8", { strokeWidth: 7, eventId: expeditionId }),
      feature("Река Лунная", "river", { type: "LineString", coordinates: [[490, 460], [460, 405], [485, 345], [445, 275], [490, 215], [515, 150]] }, "#81c0d1", { strokeWidth: 3 }),
      feature("Озеро памяти", "lake", polygon([[615, 245], [670, 290], [705, 260], [680, 210], [635, 205]]), "#538eaa", { stroke: "#9cc9d2" }),
      north,
      feature("Пограничные земли", "province", polygon([[290, 420], [335, 460], [435, 440], [460, 390], [350, 375]]), "#d3b37c", { layerId: political.id, parentId: northId, eventId: treatyId }),
      feature("Обсерватория", "city", { type: "Point", coordinates: [590, 315] }, "#ebd4a1"),
      feature("Серебряная гавань", "port", { type: "Point", coordinates: [205, 185] }, "#e5c68e"),
      feature("Северная стража", "fortress", { type: "Point", coordinates: [705, 415] }, "#e6c08d"),
      feature("Дорога хранителей", "road", { type: "LineString", coordinates: [[205, 185], [310, 270], [435, 330], [590, 315], [705, 415]] }, "#dfc99a", { strokeWidth: 2.5, eventId: expeditionId }),
      feature("Серебряное море", "label", { type: "Point", coordinates: [470, 645] }, "#accdd4"),
    ],
  });
}
