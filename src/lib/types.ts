export type CanonStatus = "draft" | "canon";
export type User = { id: string; name: string; email: string };
export type Project = { id: string; name: string; description: string; role: string; createdAt: string };
export type World = { id: string; projectId: string; name: string; description: string };
export type Character = {
  id: string; worldId: string; name: string; title: string; species: string; gender: string;
  birthYear: number | null; deathYear: number | null; appearance: string; personality: string;
  biography: string; motivation: string; abilities: string; secrets: string; status: CanonStatus; version: number;
  portraitUrl?: string | null;
};
export type LoreEvent = {
  id: string; worldId: string; name: string; type: string; startYear: number; endYear: number | null;
  description: string; characterIds: string[]; status: CanonStatus; version: number;
};
export type Relation = {
  id: string; worldId: string; fromId: string; toId: string; kind: string; mutual: boolean;
  startYear: number | null; endYear: number | null; description: string; version: number;
  familyKind?: import("./history-types").FamilyKind;
  participantIds?: string[];
};
export type WorldData = { world: World; characters: Character[]; events: LoreEvent[]; relations: Relation[]; history?: import("./history-types").HistoryContext };
