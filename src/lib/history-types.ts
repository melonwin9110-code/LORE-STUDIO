import type { CalendarDefinition } from "./calendar";
export type Timeline = {
  id: string; worldId: string; name: string; parentId: string | null; parentRevision: string | null;
  forkDay: string | null; headRevision: string; isMain: boolean; isCanon: boolean;
};
export type CalendarRecord = { id: string; worldId: string; definition: CalendarDefinition; isDefault: boolean };
export type HistoryContext = { timeline: Timeline; timelines: Timeline[]; calendars: CalendarRecord[]; day: string | null };
export type Revision = { revision: string; timelineId: string; effectiveDay: string; version: number; deleted: boolean; data: Record<string, unknown> | null; createdAt: string };
export type Difference = { id: string; kind: "characters" | "events" | "relations"; change: "added" | "removed" | "changed"; left: Record<string, unknown> | null; right: Record<string, unknown> | null };
export type FamilyKind = "other" | "parent" | "adoptive_parent" | "spouse";
