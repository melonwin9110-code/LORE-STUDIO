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
  fromId: idSchema.optional(), toId: idSchema.optional(),
  participantIds: z.array(idSchema).min(2, "Выберите не менее двух персонажей").max(10, "В отношении может быть не более 10 участников").optional(),
  kind: z.string().trim().min(1).max(100),
  familyKind: z.enum(["other", "parent", "adoptive_parent", "spouse"]).default("other"),
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
/** Legacy pairs are normalized without changing immutable stored payloads. */
export function relationParticipants(value: { participantIds?: unknown; fromId?: unknown; toId?: unknown }): string[] {
  if (Array.isArray(value.participantIds)) return value.participantIds.filter((id): id is string => typeof id === "string");
  return [value.fromId, value.toId].filter((id): id is string => typeof id === "string");
}
export const relationSchema = relationObject.superRefine((v, context) => {
  const ids = relationParticipants(v);
  if (ids.length < 2 || ids.length > 10) context.addIssue({ code: "custom", path: ["participantIds"], message: "Выберите от 2 до 10 персонажей" });
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["participantIds"], message: "Участники отношения не должны повторяться" });
  if (v.participantIds && ((v.fromId !== undefined && v.fromId !== ids[0]) || (v.toId !== undefined && v.toId !== ids[1]))) {
    context.addIssue({ code: "custom", path: ["participantIds"], message: "Начальные участники не соответствуют указанной паре" });
  }
  if (v.familyKind !== "other" && ids.length !== 2) context.addIssue({ code: "custom", path: ["familyKind"], message: "Родственная связь задаётся для пары персонажей" });
  if (v.startYear !== null && v.endYear !== null && v.endYear < v.startYear) context.addIssue({ code: "custom", path: ["endYear"], message: "Окончание не может предшествовать началу" });
}).transform((v) => {
  const participantIds = relationParticipants(v);
  return { ...v, fromId: participantIds[0], toId: participantIds[1], participantIds };
});
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
