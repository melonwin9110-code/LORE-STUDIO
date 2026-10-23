import { z } from "zod";

const title = z.string().trim().min(1, "Введите название").max(160);
const text = z.string().max(40000).default("");
export const year = z.number().int().min(-1_000_000_000).max(1_000_000_000);
const optionalYear = year.nullable().default(null);
const status = z.enum(["draft", "canon"]).default("draft");
export const idSchema = z.uuid();
export const credentialsSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(10, "Пароль должен содержать не менее 10 символов").max(128),
}).strict();
export const registrationSchema = credentialsSchema.extend({ name: z.string().trim().min(1).max(80) });
export const projectSchema = z.object({ name: title, description: z.string().max(10000).default("") }).strict();
export const worldSchema = projectSchema;
const characterObject = z.object({
  name: title, title: z.string().max(160).default(""), species: z.string().max(160).default(""),
  gender: z.string().max(160).default(""), birthYear: optionalYear, deathYear: optionalYear,
  appearance: text, personality: text, biography: text, motivation: text, abilities: text, secrets: text, status,
}).strict();
const eventObject = z.object({
  name: title, type: z.string().max(160).default("Событие"), startYear: year,
  endYear: optionalYear, description: text, characterIds: z.array(idSchema).max(500).default([]), status,
}).strict();
const relationObject = z.object({
  fromId: idSchema, toId: idSchema, kind: z.string().trim().min(1).max(100),
  mutual: z.boolean().default(true), startYear: optionalYear, endYear: optionalYear, description: text,
}).strict();
export const characterSchema = characterObject.refine(
  (v) => v.birthYear === null || v.deathYear === null || v.deathYear >= v.birthYear,
  { message: "Год смерти не может предшествовать году рождения", path: ["deathYear"] },
);
export const eventSchema = eventObject.refine(
  (v) => v.endYear === null || v.endYear >= v.startYear,
  { message: "Окончание не может предшествовать началу", path: ["endYear"] },
).refine((v) => new Set(v.characterIds).size === v.characterIds.length, { message: "Участники не должны повторяться", path: ["characterIds"] });
export const relationSchema = relationObject.refine((v) => v.fromId !== v.toId, { message: "Выберите двух разных персонажей", path: ["toId"] })
  .refine((v) => v.startYear === null || v.endYear === null || v.endYear >= v.startYear,
    { message: "Окончание не может предшествовать началу", path: ["endYear"] });
const version = z.number().int().positive();
// Remove create defaults before making fields optional: omitted PATCH fields must stay unchanged.
function patch<T extends z.ZodRawShape>(shape: T) {
  const withoutDefaults = Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, value instanceof z.ZodDefault ? value.removeDefault() : value]));
  return z.object(withoutDefaults).partial().extend({ version }).strict();
}
export const projectPatch = z.object({ name: title.optional(), description: z.string().max(10000).optional() }).strict();
export const characterPatch = patch(characterObject.shape);
export const eventPatch = patch(eventObject.shape);
export const relationPatch = patch(relationObject.shape);
