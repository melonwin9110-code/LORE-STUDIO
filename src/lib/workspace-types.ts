import type { Character, Relation } from "./types";
import type { FamilyKind } from "./history-types";
export type FamilyCharacter = Character & { sourceTimelineId: string; sourceTimelineName: string; archived?: boolean };
export type FamilyEdge = { id:string; worldId:string; fromId:string; toId:string; familyKind:Exclude<FamilyKind,"other">; description:string; version:number };
export type FamilyData = { characters:FamilyCharacter[]; relations:Relation[]; version:number; migration:{required:boolean;sources:{timelineId:string;name:string;count:number}[];message:string}|null };
export type CatalogEntry = {key:string;character:Character;project:{id:string;name:string;role:string};world:{id:string;name:string};timeline:{id:string;name:string}};
export type CatalogResult = {characters:CatalogEntry[];total:number;nextCursor:string|null};
export type TimelineConnection = {id:string;sourceId:string;targetId:string;kind:"intersection"|"influence"|"travel";label:string};
export type TimelineGraph = {version:number;positions:Record<string,{x:number;y:number}>;viewport:{x:number;y:number;zoom:number};connections:TimelineConnection[]};
