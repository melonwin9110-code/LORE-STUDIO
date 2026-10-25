import type { Revision } from "./history-types";

export type MapPoint = [number, number];
export type MapGeometry =
  | { type: "Point"; coordinates: MapPoint }
  | { type: "LineString"; coordinates: MapPoint[] }
  | { type: "Polygon"; coordinates: MapPoint[][] }
  | { type: "MultiPolygon"; coordinates: MapPoint[][][] };
export const GEOGRAPHY_TYPES = {
  continent: "Материк", island: "Остров", coastline: "Береговая линия", ocean: "Океан", sea: "Море",
  river: "Река", lake: "Озеро", mountain: "Горы", plain: "Равнина", forest: "Лес", desert: "Пустыня",
  biome: "Биом", state: "Государство", province: "Провинция", border: "Политическая граница",
  city: "Город", settlement: "Поселение", road: "Дорога", port: "Порт", fortress: "Крепость",
  label: "Подпись", custom: "Пользовательский объект",
} as const;
export type GeographyKind = keyof typeof GEOGRAPHY_TYPES;
export type MapInput = { name: string; description: string; width: number; height: number; background: string };
export type AtlasMap = MapInput & { id: string; worldId: string; version: number };
export type MapLayerInput = { name: string; kind: "physical" | "political" | "custom"; visible: boolean; locked: boolean; opacity: number; order: number };
export type MapLayer = MapLayerInput & { id: string; worldId: string; mapId: string; version: number };
export type MapFeatureInput = {
  name: string; kind: GeographyKind; layerId: string; geometry: MapGeometry;
  description: string; fill: string; stroke: string; strokeWidth: number; label: boolean;
  eventId: string | null; parentId: string | null;
};
export type MapFeature = MapFeatureInput & { id: string; worldId: string; mapId: string; version: number };
export type MapData = { map: AtlasMap; layers: MapLayer[]; features: MapFeature[]; revision: string };
export type MapChange<T> = { op: "create"; id: string; data: T } | { op: "update"; id: string; version: number; data: T } | { op: "delete"; id: string; version: number };
export type MapBatchInput = { expectedRevision: string; layers: MapChange<MapLayerInput>[]; features: MapChange<MapFeatureInput>[] };
export type MapFeatureHistory = { revisions: Revision[] };
export type MapTool = "select" | "pan" | "point" | "line" | "polygon" | "modify" | "move" | "split";
export type MapView = "physical" | "political";
