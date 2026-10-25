import type { GeographyKind, MapFeatureInput, MapGeometry, MapLayerInput, MapPoint } from "./map-types";

export const MAP_GENERATOR_VERSION = "lore-base-1";
export const MAP_BASE_BACKGROUND = "#7fa5b2";
export type MapBasePreset = "island" | "continents" | "archipelago";
export type MapBaseOptions = { seed: string; preset: MapBasePreset; width: number; height: number };
export type GeneratedMapLayer = MapLayerInput & { id: string };
export type GeneratedMapFeature = MapFeatureInput & { id: string };
export type GeneratedMapBase = {
  algorithmVersion: string;
  layers: GeneratedMapLayer[];
  features: GeneratedMapFeature[];
};

const TAU = Math.PI * 2;
const COAST_POINTS = 160;
const prefixes = ["Эль", "Айр", "Лио", "Тир", "Аве", "Нор", "Сел", "Мир", "Вел", "Ори", "Кай", "Иль"];
const endings = ["ар", "ена", "ор", "ия", "валь", "эль", "айн", "дор", "ир", "она", "рис", "ан"];
type LandSpec = { x: number; y: number; rx: number; ry: number; major: boolean };
type Land = LandSpec & { ring: MapPoint[]; name: string; point: (x: number, y: number) => MapPoint };

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

function randomStream(seed: string) {
  let value = hash(seed);
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function idStream(random: () => number) {
  return () => {
    const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    const hex = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const closed = (points: MapPoint[]): MapPoint[] => [...points, [...points[0]] as MapPoint];
const polygon = (points: MapPoint[]): Extract<MapGeometry, { type: "Polygon" }> => ({ type: "Polygon", coordinates: [closed(points)] });

function layouts(preset: MapBasePreset): LandSpec[] {
  if (preset === "island") return [
    { x: 0.5, y: 0.5, rx: 0.35, ry: 0.36, major: true },
    { x: 0.91, y: 0.27, rx: 0.035, ry: 0.06, major: false },
    { x: 0.09, y: 0.68, rx: 0.04, ry: 0.055, major: false },
  ];
  if (preset === "continents") return [
    { x: 0.27, y: 0.54, rx: 0.20, ry: 0.34, major: true },
    { x: 0.73, y: 0.47, rx: 0.20, ry: 0.32, major: true },
    { x: 0.50, y: 0.18, rx: 0.025, ry: 0.055, major: false },
  ];
  return [0.27, 0.73].flatMap((y, row) => [0.19, 0.5, 0.81].map((x, column) => ({
    x, y, rx: column === 1 ? 0.13 : 0.125, ry: row ? 0.16 : 0.165, major: true,
  })));
}

/**
 * A small deterministic world base, made entirely of editable semantic objects.
 * All normalized land polygons contain a disk of radius .71. Terrain is placed
 * within that disk; disjoint preset envelopes prevent overlapping landmasses.
 * Persisting callers must remap the deterministic IDs to fresh object UUIDs.
 */
export function createMapBase(options: MapBaseOptions): GeneratedMapBase {
  const { width, height, preset } = options;
  if (![width, height].every((value) => Number.isInteger(value) && value >= 100 && value <= 100_000)) {
    throw new RangeError("Размеры карты должны быть целыми числами от 100 до 100000");
  }
  if (!["island", "continents", "archipelago"].includes(preset)) throw new RangeError("Неизвестный вид основы карты");
  const seed = options.seed.trim();
  if (!seed || seed.length > 128) throw new RangeError("Введите ключ карты длиной от 1 до 128 символов");
  const random = randomStream(`${MAP_GENERATOR_VERSION}:${seed}:${preset}`);
  const identity = idStream(randomStream(`${MAP_GENERATOR_VERSION}:ids:${seed}:${preset}`));
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const name = () => `${pick(prefixes)}${pick(endings)}`;
  const layer = (title: string, order: number, kind: MapLayerInput["kind"] = "physical", opacity = 1): GeneratedMapLayer => ({
    id: identity(), name: title, kind, visible: true, locked: false, opacity, order,
  });
  const layers = [layer("Суша", 0), layer("Рельеф и леса", 10), layer("Реки и озёра", 20), layer("Города и дороги", 30), layer("Государства", 40, "political", 0.24)];
  const [ground, terrain, water, places, states] = layers;
  const features: GeneratedMapFeature[] = [];
  const add = (title: string, kind: GeographyKind, geometry: MapGeometry, target: GeneratedMapLayer, fill: string, extra: Partial<MapFeatureInput> = {}) => {
    const feature: GeneratedMapFeature = {
      id: identity(), name: title, kind, layerId: target.id, geometry, description: "", fill, stroke: fill,
      strokeWidth: 1.2, label: true, eventId: null, parentId: null, ...extra,
    };
    features.push(feature);
    return feature;
  };

  for (const [landIndex, spec] of layouts(preset).entries()) {
    const phases = [random() * TAU, random() * TAU, random() * TAU, random() * TAU];
    const point = (x: number, y: number): MapPoint => [rounded((spec.x + spec.rx * x) * width), rounded((spec.y + spec.ry * y) * height)];
    const normalized: MapPoint[] = Array.from({ length: COAST_POINTS }, (_, index) => {
      const angle = index * TAU / COAST_POINTS;
      const radius = Math.max(0.72, Math.min(1, 0.86 + 0.08 * Math.sin(angle * 3 + phases[0]) + 0.07 * Math.sin(angle * 5 + phases[1]) + 0.035 * Math.sin(angle * 9 + phases[2]) + 0.015 * Math.sin(angle * 13 + phases[3])));
      return [radius * Math.cos(angle), radius * Math.sin(angle)];
    });
    const land: Land = { ...spec, name: name(), point, ring: normalized.map(([x, y]) => point(x, y)) };
    const kind = preset === "continents" && spec.major ? "continent" : "island";
    add(land.name, kind, polygon(land.ring), ground, pick(["#bdc79a", "#bdc399", "#c4c9a1"]), {
      stroke: "#efe2bc", strokeWidth: 2, label: !spec.major,
      description: "Побережье готовой основы. Берег и свойства можно изменить вручную.",
    });
    if (!spec.major) continue;

    const patch = (cx: number, cy: number, rx: number, ry: number) => {
      const phase = random() * TAU;
      return polygon(Array.from({ length: 32 }, (_, index) => {
        const angle = index * TAU / 32;
        const radius = 0.88 + 0.07 * Math.sin(angle * 3 + phase) + 0.05 * Math.sin(angle * 5 - phase);
        return point(cx + Math.cos(angle) * rx * radius, cy + Math.sin(angle) * ry * radius);
      }));
    };
    add(`Долина ${name()}`, "plain", patch(-0.02, -0.13, 0.49, 0.36), terrain, "#b5c58a", { label: false, stroke: "#b5c58a" });
    add(`Лес ${name()}`, "forest", patch(-0.30, 0.07, 0.22, 0.25), terrain, "#6f946b", { stroke: "#86a57c", label: true });
    add(`Роща ${name()}`, "forest", patch(-0.07, -0.37, 0.20, 0.15), terrain, "#78996d", { stroke: "#8da878", label: false });
    add(`Пески ${name()}`, "desert", patch(0.34, -0.17, 0.19, 0.22), terrain, "#ddcc9a", { stroke: "#ddcc9a", label: false });
    const highland: MapPoint[] = [[-0.30, 0.32], [-0.17, 0.45], [-0.06, 0.34], [0.05, 0.40], [0.18, 0.29], [0.29, 0.37]];
    add(`Хребет ${name()}`, "mountain", { type: "LineString", coordinates: highland.map(([x, y]) => point(x, y)) }, terrain, "#949582", { stroke: "#8b8c7c", strokeWidth: 6, label: false });

    // The last two river vertices lie on one radial segment, ending exactly on
    // a real coast vertex. Every other segment is in the guaranteed land disk.
    const mouthIndex = 114 + Math.floor(random() * 14);
    const mouth = normalized[mouthIndex];
    const mouthLength = Math.hypot(...mouth);
    const direction: MapPoint = [mouth[0] / mouthLength, mouth[1] / mouthLength];
    const riverPoints: MapPoint[] = [[0.05, 0.40], [0.09, 0.20], [-0.03, 0.04], [0.08, -0.13], [0.02, -0.34], [direction[0] * 0.60, direction[1] * 0.60], mouth];
    add(`Река ${name()}`, "river", { type: "LineString", coordinates: riverPoints.map(([x, y]) => point(x, y)) }, water, "#629bb1", { strokeWidth: 2.5, label: false });
    add(`Ручей ${name()}`, "river", { type: "LineString", coordinates: [[-0.30, 0.32], [-0.25, 0.24], [-0.11, 0.25], [0.09, 0.20]].map(([x, y]) => point(x, y)) }, water, "#6fa3b6", { strokeWidth: 1.4, label: false });
    add(`Озеро ${name()}`, "lake", patch(-0.01, 0, 0.10, 0.075), water, "#82b3bd", { stroke: "#6295a9", strokeWidth: 0.8, label: false });

    const capital = add(`${name()} — столица`, "city", { type: "Point", coordinates: point(-0.28, -0.18) }, places, "#f2dfb7", { stroke: "#625c50", strokeWidth: 1.5 });
    const town = add(name(), "settlement", { type: "Point", coordinates: point(0.30, 0.14) }, places, "#f1dfb9", { stroke: "#6b6354", strokeWidth: 1 });
    add(`Гавань ${name()}`, "port", { type: "Point", coordinates: point(mouth[0] * 0.94, mouth[1] * 0.94) }, places, "#edcf96", { stroke: "#665e50", strokeWidth: 1 });
    add(`Форт ${name()}`, "fortress", { type: "Point", coordinates: point(0.24, 0.30) }, places, "#c1b297", { stroke: "#665e50", strokeWidth: 1, label: false });
    add(`Дорога ${land.name}`, "road", { type: "LineString", coordinates: [
      (capital.geometry as Extract<MapGeometry, { type: "Point" }>).coordinates,
      point(-0.12, -0.12), point(0.09, -0.10), point(0.20, 0.03),
      (town.geometry as Extract<MapGeometry, { type: "Point" }>).coordinates,
    ] }, places, "#b99c6c", { strokeWidth: 1.8, label: false });

    const state = add(`Королевство ${land.name}`, "state", polygon(land.ring.map(([x, y]) => [x, y])), states,
      ["#a780a7", "#ca927b", "#c3b571", "#7c9eaa", "#9d9a70", "#ba8aa0"][landIndex % 6], { stroke: "#665b78", strokeWidth: 1.6, label: true });
    add(`Область ${name()}`, "province", patch(-0.28, -0.18, 0.26, 0.23), states, "#c9b48d", {
      parentId: state.id, stroke: "#8e7c69", strokeWidth: 0.8, label: false,
    });
  }
  return { algorithmVersion: MAP_GENERATOR_VERSION, layers, features };
}
