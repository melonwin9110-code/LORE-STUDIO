import type { Revision } from "./history-types";
import type { WikiDocument } from "./wiki-document";

export type WikiSourceKind = "characters" | "events" | "maps" | "map_features";
export type WikiEntryKind = WikiSourceKind | "articles";
export type WikiKnowledge = "fact" | "legend" | "rumor" | "hypothesis" | "secret";
export type WikiArticleInput = {
  title: string;
  summary: string;
  document: WikiDocument;
  category: string;
  tags: string[];
  knowledge: WikiKnowledge;
  sourceId: string | null;
};
export type WikiArticle = WikiArticleInput & { id: string; worldId: string; version: number };
export type WikiEntry = {
  id: string;
  kind: WikiEntryKind;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  knowledge: WikiKnowledge;
  hasArticle: boolean;
};
export type WikiFact = { label: string; value: string };
export type WikiIndex = { entries: WikiEntry[]; categories: string[]; tags: string[]; revision: string };
export type WikiPage = {
  entry: WikiEntry;
  article: WikiArticle | null;
  facts: WikiFact[];
  backlinks: WikiEntry[];
  related: WikiEntry[];
  targets: WikiEntry[];
  revision: string;
};
export type WikiHistory = { revisions: Revision[] };
export type WikiFilters = { query?: string; category?: string; tag?: string; kind?: WikiEntryKind; knowledge?: WikiKnowledge };
export type WikiImage = { id: string; url: string; width: number; height: number; bytes: number };
