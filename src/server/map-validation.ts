import { z } from "zod";
import { GEOGRAPHY_TYPES, type GeographyKind, type MapGeometry } from "@/lib/map-types";
import { revisionSchema } from "./history-validation";
import { idSchema } from "./validation";

export const MAX_GEOMETRY_VERTICES = 10_000;
export const MAX_BATCH_VERTICES = 100_000;
export const MAX_MAP_CHANGES = 200;
const uuid = idSchema.transform((value) => value.toLowerCase());
const name = z.string().trim().min(1, "Введите название").max(160);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Укажите цвет в формате #RRGGBB");
const version = z.number().int().min(1).max(2_147_483_646);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const point = z.tuple([coordinate, coordinate]);
const ring = z.array(point).min(4, "В замкнутом контуре нужны не менее трёх вершин").max(MAX_GEOMETRY_VERTICES)
  .refine((points) => points.length > 0 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1], "Контур многоугольника должен быть замкнут");
const pointGeometry = z.object({ type: z.literal("Point"), coordinates: point }).strict();
const lineGeometry = z.object({ type: z.literal("LineString"), coordinates: z.array(point).min(2, "В линии нужны не менее двух вершин").max(MAX_GEOMETRY_VERTICES) }).strict();
const polygonGeometry = z.object({ type: z.literal("Polygon"), coordinates: z.array(ring).min(1).max(MAX_GEOMETRY_VERTICES) }).strict();
const multiPolygonGeometry = z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(ring).min(1).max(MAX_GEOMETRY_VERTICES)).min(1).max(MAX_GEOMETRY_VERTICES) }).strict();

export function countGeometryVertices(geometry: MapGeometry): number {
  switch (geometry.type) {
    case "Point": return 1;
    case "LineString": return geometry.coordinates.length;
    case "Polygon": return geometry.coordinates.reduce((sum, contour) => sum + contour.length, 0);
    case "MultiPolygon": return geometry.coordinates.reduce((sum, polygon) => sum + polygon.reduce((subtotal, contour) => subtotal + contour.length, 0), 0);
  }
}

function boundedGeometry(value: MapGeometry, context: z.RefinementCtx) {
  if (countGeometryVertices(value) > MAX_GEOMETRY_VERTICES) {
    context.addIssue({ code: "custom", path: ["coordinates"], message: `В одном объекте может быть не более ${MAX_GEOMETRY_VERTICES} вершин` });
  }
}
export const geometrySchema = z.discriminatedUnion("type", [pointGeometry, lineGeometry, polygonGeometry, multiPolygonGeometry]).superRefine(boundedGeometry);
const territoryGeometrySchema = z.discriminatedUnion("type", [polygonGeometry, multiPolygonGeometry]).superRefine(boundedGeometry);
const cutterGeometrySchema = lineGeometry.superRefine(boundedGeometry);

const lineKinds = new Set<GeographyKind>(["coastline", "river", "road", "border"]);
const pointKinds = new Set<GeographyKind>(["city", "settlement", "port", "fortress", "label"]);
const flexibleKinds = new Set<GeographyKind>(["mountain", "custom"]);

export const mapCreateSchema = z.object({
  name,
  description: z.string().max(10_000).default(""),
  width: z.number().int().min(100).max(100_000).default(1000),
  height: z.number().int().min(100).max(100_000).default(700),
  background: color.default("#132530"),
  generation: z.object({
    seed: z.string().trim().min(1).max(128),
    preset: z.enum(["island", "continents", "archipelago"]),
    algorithmVersion: z.string().min(1).max(80),
  }).strict().optional(),
}).strict();

export const mapPatchSchema = z.object({
  version,
  name: name.optional(),
  description: z.string().max(10_000).optional(),
  background: color.optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "version"), "Нет изменений для сохранения");
export const mapDeleteSchema = z.object({ version }).strict();

export const mapLayerSchema = z.object({
  name,
  kind: z.enum(["physical", "political", "custom"]),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  opacity: z.number().finite().min(0).max(1).default(1),
  order: z.number().int().min(0).max(10_000).default(0),
}).strict();

export const mapFeatureSchema = z.object({
  name,
  kind: z.enum(Object.keys(GEOGRAPHY_TYPES) as [GeographyKind, ...GeographyKind[]]),
  layerId: uuid,
  geometry: geometrySchema,
  description: z.string().max(40_000).default(""),
  fill: color.default("#77966d"),
  stroke: color.default("#b2c7a2"),
  strokeWidth: z.number().finite().min(0.5).max(10).default(1.5),
  label: z.boolean().default(true),
  eventId: uuid.nullable().default(null),
  parentId: uuid.nullable().default(null),
}).strict().superRefine((value, context) => {
  const type = value.geometry.type;
  if ((lineKinds.has(value.kind) && type !== "LineString") || (pointKinds.has(value.kind) && type !== "Point") ||
      (!lineKinds.has(value.kind) && !pointKinds.has(value.kind) && !flexibleKinds.has(value.kind) && type !== "Polygon" && type !== "MultiPolygon")) {
    context.addIssue({ code: "custom", path: ["geometry"], message: "Геометрия не соответствует типу географического объекта" });
  }
});

function changes<T extends z.ZodType>(data: T) {
  return z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), id: uuid, data }).strict(),
    z.object({ op: z.literal("update"), id: uuid, version, data }).strict(),
    z.object({ op: z.literal("delete"), id: uuid, version }).strict(),
  ])).max(MAX_MAP_CHANGES).default([]);
}

export const mapBatchSchema = z.object({
  expectedRevision: revisionSchema,
  layers: changes(mapLayerSchema),
  features: changes(mapFeatureSchema),
}).strict().superRefine((value, context) => {
  const combined = [...value.layers, ...value.features];
  if (!combined.length) context.addIssue({ code: "custom", message: "Нет изменений для сохранения" });
  if (combined.length > MAX_MAP_CHANGES) context.addIssue({ code: "custom", message: `За один раз можно сохранить не более ${MAX_MAP_CHANGES} изменений` });
  if (new Set(combined.map((change) => change.id)).size !== combined.length) {
    context.addIssue({ code: "custom", message: "Один объект нельзя изменять несколько раз в одном запросе" });
  }
  let vertices = 0;
  for (const [index, change] of value.features.entries()) {
    if (change.op === "delete") continue;
    vertices += countGeometryVertices(change.data.geometry);
    if (change.id === change.data.parentId) {
      context.addIssue({ code: "custom", path: ["features", index, "data", "parentId"], message: "Объект не может быть своей родительской территорией" });
    }
  }
  if (vertices > MAX_BATCH_VERTICES) context.addIssue({ code: "custom", path: ["features"], message: `За один раз можно сохранить не более ${MAX_BATCH_VERTICES} вершин` });
});

export const mapMergeSchema = z.object({
  geometries: z.array(territoryGeometrySchema).min(2).max(20),
}).strict().refine((value) => value.geometries.reduce((sum, geometry) => sum + countGeometryVertices(geometry), 0) <= MAX_BATCH_VERTICES, "Слишком много вершин для объединения");
export const mapSplitSchema = z.object({
  geometry: territoryGeometrySchema,
  cutter: cutterGeometrySchema,
}).strict();
