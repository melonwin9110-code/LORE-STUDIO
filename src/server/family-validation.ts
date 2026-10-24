import { z } from "zod";
import { idSchema } from "./validation";
import { daySchema } from "./history-validation";
const familyKind = z.enum(["parent", "adoptive_parent", "spouse"]);
const expectedVersion = z.number().int().nonnegative();
const description = z.string().max(10000);
export const familyCreateSchema = z.object({ fromId: idSchema, toId: idSchema, familyKind, description: description.default(""), expectedVersion }).strict()
  .refine((v) => v.fromId !== v.toId, { message: "Выберите двух разных персонажей", path: ["toId"] });
export const familyPatchSchema = z.object({ fromId: idSchema.optional(), toId: idSchema.optional(), familyKind: familyKind.optional(), description: description.optional(), version: z.number().int().positive(), expectedVersion }).strict()
  .refine((v) => Object.keys(v).some((key) => key !== "version" && key !== "expectedVersion"), "Нет изменений для сохранения");
export const familyImportSchema = z.object({ timelineId: idSchema, day: daySchema.optional(), expectedVersion }).strict();
export const familyDeleteSchema = z.object({ expectedVersion }).strict();
