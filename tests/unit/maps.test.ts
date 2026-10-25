import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MapGeometry, MapPoint } from "../../src/lib/map-types";
import { countGeometryVertices, geometrySchema, mapBatchSchema, mapCreateSchema, mapFeatureSchema, mapMergeSchema, mapPatchSchema, mapSplitSchema } from "../../src/server/map-validation";

const layerId = "a1191d39-5db6-4b8a-908c-3196dc59c303";
const square: MapGeometry = { type: "Polygon", coordinates: [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]] };
const feature = (geometry: MapGeometry = square, kind = "state") => ({ name: "Северное королевство", kind, layerId, geometry });
const change = (id: string = randomUUID()) => ({ op: "create", id, data: feature() });

describe("cartographic geometry input boundaries", () => {
  it("accepts supported planar shapes including holes and disjoint territories", () => {
    const withHole: MapGeometry = { type: "Polygon", coordinates: [...square.coordinates, [[5, 5], [5, 10], [10, 10], [10, 5], [5, 5]]] };
    const islands: MapGeometry = { type: "MultiPolygon", coordinates: [withHole.coordinates, [[[40, 40], [50, 40], [50, 50], [40, 40]]]] };
    for (const geometry of [square, withHole, islands, { type: "Point", coordinates: [0, 0] }, { type: "LineString", coordinates: [[0, 0], [100_000, 100_000]] }]) {
      expect(geometrySchema.safeParse(geometry).success).toBe(true);
    }
    expect(countGeometryVertices(islands)).toBe(14);
  });
  it("rejects non-finite, three-dimensional and excessively large coordinate values", () => {
    for (const coordinates of [[NaN, 5], [Infinity, 0], [0, -Infinity], [100_001, 5], [0, -100_001], [0, 0, 1], [0], ["1", 2]]) {
      expect(geometrySchema.safeParse({ type: "Point", coordinates }).success).toBe(false);
    }
    expect(geometrySchema.safeParse({ type: "Point", coordinates: [1, 2], crs: "EPSG:4326" }).success).toBe(false);
    expect(geometrySchema.safeParse({ type: "GeometryCollection", geometries: [] }).success).toBe(false);
  });
  it("rejects open contours, missing rings and lines with fewer than two vertices", () => {
    for (const geometry of [
      { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] },
      { type: "Polygon", coordinates: [[[0, 0], [10, 10], [0, 0]]] },
      { type: "Polygon", coordinates: [] },
      { type: "MultiPolygon", coordinates: [[]] },
      { type: "LineString", coordinates: [[10, 10]] },
    ]) expect(geometrySchema.safeParse(geometry).success).toBe(false);
  });
  it("counts all rings and polygons toward the geometry vertex budget", () => {
    const contour = (vertices: number): MapPoint[] => [...Array.from({ length: vertices - 1 }, (_, index): MapPoint => [index, index % 2]), [0, 0]];
    expect(geometrySchema.safeParse({ type: "LineString", coordinates: Array.from({ length: 10_000 }, (_, index) => [index, 0]) }).success).toBe(true);
    expect(geometrySchema.safeParse({ type: "LineString", coordinates: Array.from({ length: 10_001 }, (_, index) => [index, 0]) }).success).toBe(false);
    expect(geometrySchema.safeParse({ type: "Polygon", coordinates: [contour(5001), contour(5000)] }).success).toBe(false);
    expect(geometrySchema.safeParse({ type: "MultiPolygon", coordinates: [[contour(5001)], [contour(5000)]] }).success).toBe(false);
  });
  it("keeps semantic rivers, cities and territories distinct from their appearance", () => {
    expect(mapFeatureSchema.safeParse(feature({ type: "LineString", coordinates: [[1, 1], [20, 20]] }, "river")).success).toBe(true);
    expect(mapFeatureSchema.safeParse(feature({ type: "Point", coordinates: [10, 10] }, "city")).success).toBe(true);
    for (const [kind, geometry] of [["city", square], ["river", square], ["state", { type: "Point", coordinates: [1, 1] }], ["forest", { type: "LineString", coordinates: [[0, 0], [1, 1]] }]] as const) {
      expect(mapFeatureSchema.safeParse({ ...feature(), kind, geometry }).success).toBe(false);
    }
    expect(mapFeatureSchema.safeParse({ ...feature(), kind: "fake-river", fill: "#3366aa" }).success).toBe(false);
    expect(mapFeatureSchema.parse(feature()).eventId).toBeNull();
  });
});

describe("atomic map editing requests", () => {
  it("applies map creation defaults without allowing a patch to resize or reset omitted settings", () => {
    expect(mapCreateSchema.parse({ name: "  Архипелаг  " })).toEqual({ name: "Архипелаг", description: "", width: 1000, height: 700, background: "#132530" });
    expect(mapPatchSchema.parse({ version: 7, name: "Новый заголовок" })).toEqual({ version: 7, name: "Новый заголовок" });
    for (const input of [{ version: 7 }, { name: "Без версии" }, { version: 7, width: 2000 }, { version: 0, name: "Карты" }]) {
      expect(mapPatchSchema.safeParse(input).success).toBe(false);
    }
    for (const width of [99, 100_001, 120.5, NaN]) expect(mapCreateSchema.safeParse({ name: "Карта", width }).success).toBe(false);
    expect(mapFeatureSchema.safeParse({ ...feature(), fill: "url(javascript:alert(1))" }).success).toBe(false);
  });
  it("requires versions for edits/deletes and prevents client ownership or identity injection", () => {
    const id = randomUUID();
    const valid = { expectedRevision: "300", features: [{ op: "update", id, version: 2, data: feature() }] };
    expect(mapBatchSchema.parse(valid).features[0]).toMatchObject({ op: "update", id, version: 2 });
    expect(mapBatchSchema.safeParse({ ...valid, features: [{ op: "update", id, data: feature() }] }).success).toBe(false);
    expect(mapBatchSchema.safeParse({ expectedRevision: "300", features: [{ op: "delete", id, version: 0 }] }).success).toBe(false);
    expect(mapBatchSchema.safeParse({ expectedRevision: "300", features: [{ ...change(id), data: { ...feature(), worldId: randomUUID() } }] }).success).toBe(false);
    for (const expectedRevision of ["03", "-1", "1.5", "9223372036854775808", 3]) expect(mapBatchSchema.safeParse({ expectedRevision, features: [change()] }).success).toBe(false);
  });
  it("rejects repeated IDs even across kinds or UUID letter case, and self-parenting", () => {
    const id = "ab191d39-5db6-4b8a-908c-3196dc59c303";
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", features: [change(id), change(id.toUpperCase())] }).success).toBe(false);
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", layers: [{ op: "create", id, data: { name: "Слой", kind: "physical" } }], features: [change(id)] }).success).toBe(false);
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", features: [{ ...change(id), data: { ...feature(), parentId: id } }] }).success).toBe(false);
  });
  it("limits the entire batch rather than each list independently", () => {
    const layers = Array.from({ length: 100 }, () => ({ op: "delete", id: randomUUID(), version: 1 }));
    const features = Array.from({ length: 100 }, () => ({ op: "delete", id: randomUUID(), version: 1 }));
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", layers, features }).success).toBe(true);
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", layers, features: [...features, { op: "delete", id: randomUUID(), version: 1 }] }).success).toBe(false);
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", layers: [], features: [] }).success).toBe(false);
    const geometry: MapGeometry = { type: "LineString", coordinates: Array.from({ length: 10_000 }, (_, index): MapPoint => [index, 0]) };
    const dense = Array.from({ length: 10 }, () => ({ op: "create", id: randomUUID(), data: feature(geometry, "river") }));
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", features: dense }).success).toBe(true);
    expect(mapBatchSchema.safeParse({ expectedRevision: "0", features: [...dense, { op: "create", id: randomUUID(), data: feature(geometry, "river") }] }).success).toBe(false);
  });
  it("requires territory inputs for merge and a real line cutter for split", () => {
    expect(mapMergeSchema.safeParse({ geometries: [square, square] }).success).toBe(true);
    expect(mapMergeSchema.safeParse({ geometries: [square] }).success).toBe(false);
    expect(mapMergeSchema.safeParse({ geometries: [square, { type: "Point", coordinates: [1, 2] }] }).success).toBe(false);
    expect(mapSplitSchema.safeParse({ geometry: square, cutter: { type: "LineString", coordinates: [[15, -10], [15, 40]] } }).success).toBe(true);
    expect(mapSplitSchema.safeParse({ geometry: square, cutter: square }).success).toBe(false);
  });
});
