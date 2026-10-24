import { z } from "zod";
import { ApiError } from "./errors";
import { idSchema } from "./validation";
export const BASELINE_DAY = "-1000000000000000";
export const LATEST_DAY = "1000000000000000";
const integerText = z.string().regex(/^-?(0|[1-9]\d*)$/, "Ожидается целое число дней").max(18);
export const daySchema = integerText.refine((s) => /^-?(0|[1-9]\d*)$/.test(s) && s.length <= 18 && BigInt(s) >= BigInt(BASELINE_DAY) && BigInt(s) <= BigInt(LATEST_DAY), "Дата вне поддерживаемого диапазона").transform((s) => BigInt(s).toString());
export const revisionSchema = z.string().regex(/^(0|[1-9]\d*)$/, "Некорректная редакция").max(19).refine((s) => /^(0|[1-9]\d*)$/.test(s) && s.length <= 19 && BigInt(s) <= 9223372036854775807n, "Редакция вне диапазона");
export type TemporalOptions = { timelineId?: string; day?: string; revision?: string };
export function temporalOptions(search: URLSearchParams, write = false): TemporalOptions {
  if (write && search.has("revision")) throw new ApiError(400, "Нельзя изменять зафиксированную редакцию");
  const options: TemporalOptions = {};
  if (search.has("timeline")) options.timelineId = idSchema.parse(search.get("timeline"));
  if (search.has("day")) options.day = daySchema.parse(search.get("day"));
  if (search.has("revision")) options.revision = revisionSchema.parse(search.get("revision"));
  return options;
}
export const timelineCreateSchema = z.object({ name: z.string().trim().min(1).max(160), isCanon: z.boolean().default(false), parentId: idSchema.optional(), forkDay: daySchema.optional(), expectedParentRevision: revisionSchema.optional() }).strict().superRefine((v,c) => {
  if (v.parentId && (v.forkDay === undefined || v.expectedParentRevision === undefined)) c.addIssue({code:"custom",message:"Для ответвления нужны дата и редакция родителя"});
  if (!v.parentId && (v.forkDay !== undefined || v.expectedParentRevision !== undefined)) c.addIssue({code:"custom",message:"Независимая линия не имеет даты ответвления"});
});
export const timelinePatchSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), isCanon: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, "Нет изменений");
const leapSchema = z.object({ every: z.number().int().min(1).max(10000), exceptEvery: z.number().int().min(1).max(10000).nullable(), includeEvery: z.number().int().min(1).max(10000).nullable(), month: z.number().int().min(1).max(36), days: z.number().int().min(1).max(1000), offset: z.number().int().min(-1000000000).max(1000000000) }).strict();
export const calendarCreateSchema = z.object({ definition: z.object({ name: z.string().trim().min(1).max(160), months: z.array(z.object({ name: z.string().trim().min(1).max(80), days: z.number().int().min(1).max(1000) }).strict()).min(1).max(36), leap: leapSchema.nullable(), epochOffset: daySchema, era: z.string().max(80) }).strict() }).strict();
export const transferSchema = z.object({ sourceId: idSchema, objectIds: z.array(idSchema).min(1).max(1000).refine((v)=>new Set(v).size===v.length,"Объекты не должны повторяться"), sourceDay: daySchema.optional(), targetDay: daySchema.optional(), expectedRevision: revisionSchema, expectedSourceRevision: revisionSchema.optional(), overwrite: z.boolean().default(false), includeDependencies: z.boolean().default(false) }).strict();
