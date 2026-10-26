import { z } from "zod";
import { wikiDocumentSchema } from "@/lib/wiki-document";
import { idSchema } from "./validation";

const version = z.number().int().min(1).max(2_147_483_646);
const title = z.string().trim().min(1, "Введите название статьи").max(200);
const category = z.string().trim().max(80);
const tag = z.string().trim().min(1).max(60);
const tags = z.array(tag).max(20).transform((items) => {
  const seen = new Set<string>();
  return items.filter((item) => { const normalized = item.toLocaleLowerCase("ru"); if (seen.has(normalized)) return false; seen.add(normalized); return true; });
});
const knowledge = z.enum(["fact", "legend", "rumor", "hypothesis", "secret"]);
const sourceId = idSchema.transform((id) => id.toLowerCase()).nullable();
const summary = z.string().max(4000);
export const wikiCreateSchema = z.object({
  title,
  summary: summary.default(""),
  document: wikiDocumentSchema,
  category: category.default(""),
  tags: tags.default([]),
  knowledge: knowledge.default("fact"),
  sourceId: sourceId.default(null),
}).strict();
// Optional patch fields must not inherit create defaults: a title-only change
// must preserve the document's metadata, linked source and classification.
export const wikiPatchSchema = z.object({
  version,
  title: title.optional(),
  summary: summary.optional(),
  document: wikiDocumentSchema.optional(),
  category: category.optional(),
  tags: tags.optional(),
  knowledge: knowledge.optional(),
  sourceId: sourceId.optional(),
}).strict()
  .refine((value) => Object.keys(value).some((key) => key !== "version"), "Нет изменений для сохранения");
export const wikiDeleteSchema = z.object({ version }).strict();
export const wikiFiltersSchema = z.object({
  query: z.string().trim().max(200).optional(),
  category: category.optional(),
  tag: tag.optional(),
  kind: z.enum(["characters", "events", "maps", "map_features", "articles"]).optional(),
  knowledge: knowledge.optional(),
}).strict();
