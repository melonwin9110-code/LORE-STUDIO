import { describe, expect, it } from "vitest";
import { createMapBase, MAP_GENERATOR_VERSION, type MapBasePreset } from "../../src/lib/map-generator";
import type { MapFeatureInput, MapGeometry, MapPoint } from "../../src/lib/map-types";
import { mapBatchSchema } from "../../src/server/map-validation";

const presets: MapBasePreset[] = ["island", "continents", "archipelago"];
const options = { seed: "Серебряное море", preset: "island" as const, width: 1000, height: 700 };

function points(geometry: MapGeometry): MapPoint[] {
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates.flat();
  return geometry.coordinates.flat(2);
}
function onSegment(point: MapPoint, a: MapPoint, b: MapPoint, epsilon = 0.00001) {
  return Math.abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) <= epsilon * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])) &&
    point[0] >= Math.min(a[0], b[0]) - epsilon && point[0] <= Math.max(a[0], b[0]) + epsilon && point[1] >= Math.min(a[1], b[1]) - epsilon && point[1] <= Math.max(a[1], b[1]) + epsilon;
}
function inRing(point: MapPoint, ring: MapPoint[]) {
  let inside = false;
  for (let index = 0; index < ring.length - 1; index++) {
    const a = ring[index], b = ring[index + 1];
    if (onSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function ring(feature: MapFeatureInput) { return (feature.geometry as Extract<MapGeometry, { type: "Polygon" }>).coordinates[0]; }

describe("deterministic editable map bases", () => {
  it("repeats the complete result for the same seed without sharing mutable state", () => {
    const first = createMapBase(options), second = createMapBase(options);
    expect(first).toEqual(second); expect(first.algorithmVersion).toBe(MAP_GENERATOR_VERSION);
    const original = JSON.stringify(second);
    (first.features[0].geometry as Extract<MapGeometry, { type: "Polygon" }>).coordinates[0][0][0] += 10;
    expect(JSON.stringify(second)).toBe(original);
    expect(createMapBase(options)).toEqual(second);
    expect(createMapBase({ ...options, seed: "Иной мир" }).features[0].geometry).not.toEqual(second.features[0].geometry);
  });

  it.each(presets)("%s remains one valid atomic editable batch with unique references and dimensions", (preset) => {
    for (const [width, height] of [[100, 100], [1000, 700], [100000, 100]]) {
      const base = createMapBase({ ...options, preset, width, height });
      expect(base.layers.length + base.features.length).toBeLessThanOrEqual(120);
      const ids = [...base.layers, ...base.features].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      const parsed = mapBatchSchema.safeParse({ expectedRevision: "0", layers: base.layers.map(({ id, ...data }) => ({ op: "create", id, data })), features: base.features.map(({ id, ...data }) => ({ op: "create", id, data })) });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      const layerIds = new Set(base.layers.map((layer) => layer.id));
      for (const feature of base.features) {
        expect(layerIds.has(feature.layerId)).toBe(true);
        for (const [x, y] of points(feature.geometry)) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(width); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(height); }
        if (feature.parentId) expect(base.features.find((parent) => parent.id === feature.parentId)?.kind).toBe("state");
      }
      expect(new Set(base.features.map((feature) => feature.kind))).toEqual(new Set(["island", ...(preset === "continents" ? ["continent"] : []), "plain", "forest", "desert", "mountain", "river", "lake", "city", "settlement", "port", "fortress", "road", "state", "province"]));
    }
  });

  it.each(presets)("%s puts terrain, river paths and towns on real land, with mouths at the coast", (preset) => {
    for (const seed of ["Один", "Другой", "Мир 2026", "🌍"]) {
      const base = createMapBase({ ...options, preset, seed });
      const lands = base.features.filter((feature) => feature.kind === "continent" || feature.kind === "island");
      for (const feature of base.features.filter((feature) => !["continent", "island", "state"].includes(feature.kind))) {
        for (const point of points(feature.geometry)) expect(lands.some((land) => inRing(point, ring(land))), `${preset}/${seed}: ${feature.kind} outside land`).toBe(true);
        if (feature.geometry.type === "LineString") for (let index = 1; index < feature.geometry.coordinates.length; index++) {
          const a = feature.geometry.coordinates[index - 1], b = feature.geometry.coordinates[index];
          for (let step = 1; step < 8; step++) { const point: MapPoint = [a[0] + (b[0] - a[0]) * step / 8, a[1] + (b[1] - a[1]) * step / 8]; expect(lands.some((land) => inRing(point, ring(land))), `${feature.name} crosses ocean`).toBe(true); }
        }
      }
      for (const river of base.features.filter((feature) => feature.kind === "river" && feature.name.startsWith("Река "))) {
        const vertices = (river.geometry as Extract<MapGeometry, { type: "LineString" }>).coordinates;
        expect(lands.some((land) => ring(land).some((point) => point[0] === vertices.at(-1)![0] && point[1] === vertices.at(-1)![1]))).toBe(true);
      }
    }
  });

  it("rejects unsupported sizes, presets and empty seeds rather than making invalid geometry", () => {
    for (const patch of [{ width: 99 }, { width: 100001 }, { width: Number.NaN }, { height: 100.5 }, { seed: " " }, { seed: "x".repeat(129) }, { preset: "earth" as MapBasePreset }]) {
      expect(() => createMapBase({ ...options, ...patch })).toThrow(RangeError);
    }
  });
});
