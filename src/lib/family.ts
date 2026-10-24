import type { Character, Relation } from "./types";

export type FamilyEdge = { id: string; fromId: string; toId: string; kind: "parent" | "adoptive_parent" | "spouse" };
export type FamilyNode = {
  id: string;
  character: Character;
  parents: string[];
  children: string[];
  siblings: string[];
  spouses: string[];
  generation: number;
  /** No parent is recorded; do not invent extra people or parent slots. */
  unknownParents: boolean;
};
export type FamilyTree = { nodes: FamilyNode[]; edges: FamilyEdge[] };

function familyEdges(relations: Relation[]): FamilyEdge[] {
  return relations.flatMap((relation) => relation.familyKind === "parent" || relation.familyKind === "adoptive_parent" || relation.familyKind === "spouse"
    ? [{ id: relation.id, fromId: relation.fromId, toId: relation.toId, kind: relation.familyKind }]
    : []);
}

/** Caller supplies the relations active at the selected date/revision. */
export function assertFamilyConsistent(characters: Character[], relations: Relation[]): void {
  const known = new Map(characters.map((character) => [character.id, character]));
  if (known.size !== characters.length) throw new Error("Идентификаторы персонажей не должны повторяться");
  const children = new Map(characters.map((character) => [character.id, new Set<string>()]));
  const indegree = new Map(characters.map((character) => [character.id, 0]));
  for (const edge of familyEdges(relations)) {
    const parent = known.get(edge.fromId), child = known.get(edge.toId);
    if (!parent || !child) throw new Error("Родственная связь ссылается на отсутствующего персонажа");
    if (parent.worldId !== child.worldId) throw new Error("Родственная связь должна оставаться внутри одного мира");
    if (edge.fromId === edge.toId) throw new Error("Персонаж не может быть родственником самому себе");
    if (edge.kind === "spouse") continue;
    if (edge.kind === "parent") {
      if (parent.birthYear !== null && child.birthYear !== null && child.birthYear < parent.birthYear) {
        throw new Error("Ребёнок не может родиться раньше своего биологического родителя");
      }
      if (parent.deathYear !== null && child.birthYear !== null && child.birthYear > parent.deathYear) {
        throw new Error("Рождение ребёнка позже смерти биологического родителя противоречит указанным датам");
      }
    }
    // Deduplicate multiple simultaneous relation categories for the same ancestry edge.
    const targets = children.get(edge.fromId)!;
    if (!targets.has(edge.toId)) {
      targets.add(edge.toId);
      indegree.set(edge.toId, indegree.get(edge.toId)! + 1);
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index])!) {
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  if (queue.length !== characters.length) throw new Error("Родственные связи создают цикл происхождения");
}

/** Derives display-only siblings and generations from the shared relationship records. */
export function deriveFamily(characters: Character[], relations: Relation[]): FamilyTree {
  const known = new Set(characters.map((character) => character.id));
  const edges = familyEdges(relations).filter((edge) => known.has(edge.fromId) && known.has(edge.toId));
  const parents = new Map(characters.map((character) => [character.id, new Set<string>()]));
  const children = new Map(characters.map((character) => [character.id, new Set<string>()]));
  const spouses = new Map(characters.map((character) => [character.id, new Set<string>()]));
  const siblings = new Map(characters.map((character) => [character.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.kind === "spouse") {
      spouses.get(edge.fromId)!.add(edge.toId);
      spouses.get(edge.toId)!.add(edge.fromId);
    } else {
      parents.get(edge.toId)!.add(edge.fromId);
      children.get(edge.fromId)!.add(edge.toId);
    }
  }
  for (const group of children.values()) {
    for (const first of group) for (const second of group) if (first !== second) siblings.get(first)!.add(second);
  }
  const generations = new Map(characters.map((character) => [character.id, 0]));
  const indegree = new Map([...parents].map(([id, group]) => [id, group.size]));
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const child of children.get(id)!) {
      generations.set(child, Math.max(generations.get(child)!, generations.get(id)! + 1));
      const remaining = indegree.get(child)! - 1;
      indegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  const nodes = characters.map((character): FamilyNode => ({
    id: character.id, character, parents: [...parents.get(character.id)!].sort(),
    children: [...children.get(character.id)!].sort(), siblings: [...siblings.get(character.id)!].sort(),
    spouses: [...spouses.get(character.id)!].sort(), generation: generations.get(character.id)!,
    unknownParents: parents.get(character.id)!.size === 0,
  }));
  return { nodes, edges };
}
