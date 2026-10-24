import { describe, expect, it } from "vitest";
import type { Character, Relation } from "../../src/lib/types";
import { assertFamilyConsistent, deriveFamily } from "../../src/lib/family";

function character(id: string, birthYear: number | null = null, deathYear: number | null = null): Character {
  return { id, worldId: "world", name: id, title: "", species: "", gender: "", birthYear, deathYear, appearance: "", personality: "", biography: "", motivation: "", abilities: "", secrets: "", status: "draft", version: 1 };
}
function relation(fromId: string, toId: string, familyKind: Relation["familyKind"] = "parent", id = `${fromId}-${toId}-${familyKind}`): Relation {
  return { id, worldId: "world", fromId, toId, familyKind, kind: "Родство", mutual: false, startYear: null, endYear: null, description: "", version: 1 };
}

describe("shared family relationships", () => {
  it("derives generations, spouses, half siblings and unknown parents without extra stored links", () => {
    const characters = [character("родитель"), character("супруг"), character("сын"), character("дочь"), character("внук"), character("неизвестный")];
    const relations = [relation("родитель", "сын"), relation("родитель", "дочь"), relation("сын", "внук"), relation("родитель", "супруг", "spouse")];
    const before = JSON.stringify(relations);
    assertFamilyConsistent(characters, relations);
    const tree = deriveFamily(characters, relations);
    expect(tree.edges).toHaveLength(4);
    expect(tree.nodes.find((node) => node.id === "сын")).toMatchObject({ parents: ["родитель"], siblings: ["дочь"], children: ["внук"], generation: 1, unknownParents: false });
    expect(tree.nodes.find((node) => node.id === "внук")?.generation).toBe(2);
    expect(tree.nodes.find((node) => node.id === "супруг")?.spouses).toEqual(["родитель"]);
    expect(tree.nodes.find((node) => node.id === "неизвестный")?.unknownParents).toBe(true);
    expect(JSON.stringify(relations)).toBe(before);
  });
  it("rejects biological and mixed adoption cycles while ignoring unrelated categories", () => {
    const characters = [character("a"), character("b"), character("c")];
    expect(() => assertFamilyConsistent(characters, [relation("a", "b"), relation("b", "c", "adoptive_parent"), relation("c", "a")])).toThrow(/цикл/);
    expect(() => assertFamilyConsistent(characters, [relation("a", "a")])).toThrow();
    expect(() => assertFamilyConsistent(characters, [relation("a", "b", "other"), relation("b", "a", "other")])).not.toThrow();
    expect(() => assertFamilyConsistent(characters, [relation("a", "b", "spouse"), relation("b", "a", "spouse")])).not.toThrow();
  });
  it("detects known biological chronology contradictions without inventing ages", () => {
    expect(() => assertFamilyConsistent([character("parent", 100), character("child", 99)], [relation("parent", "child")])).toThrow(/раньше/);
    expect(() => assertFamilyConsistent([character("parent", 20, 50), character("child", 51)], [relation("parent", "child")])).toThrow(/смерти/);
    expect(() => assertFamilyConsistent([character("parent", 20, 50), character("child", 50)], [relation("parent", "child")])).not.toThrow();
    expect(() => assertFamilyConsistent([character("parent"), character("child", -100)], [relation("parent", "child")])).not.toThrow();
    // Adoption may occur long after either person's birth; child birth is not adoption date.
    expect(() => assertFamilyConsistent([character("parent", 100), character("child", 90)], [relation("parent", "child", "adoptive_parent")])).not.toThrow();
  });
  it("deduplicates ancestry categories and does not manufacture duplicate sibling records", () => {
    const characters = [character("a"), character("b"), character("c")];
    const relations = [relation("a", "b"), relation("a", "b", "adoptive_parent"), relation("a", "c")];
    expect(() => assertFamilyConsistent(characters, relations)).not.toThrow();
    expect(deriveFamily(characters, relations).nodes.find((node) => node.id === "b")).toMatchObject({ parents: ["a"], siblings: ["c"], generation: 1 });
    expect(deriveFamily(characters, relations).edges).toHaveLength(3);
  });
  it("rejects dangling and cross-world ancestry references", () => {
    expect(() => assertFamilyConsistent([character("a")], [relation("a", "b")])).toThrow(/отсутствующего/);
    const second = { ...character("b"), worldId: "other-world" };
    expect(() => assertFamilyConsistent([character("a"), second], [relation("a", "b")])).toThrow(/мира/);
  });
  it("supports deep ancestry without recursion depth limits", () => {
    const characters = Array.from({ length: 15000 }, (_, i) => character(`c${i}`));
    const relations = characters.slice(1).map((child, i) => relation(characters[i].id, child.id));
    expect(() => assertFamilyConsistent(characters, relations)).not.toThrow();
    const tree = deriveFamily(characters, relations);
    expect(tree.nodes.at(-1)?.generation).toBe(14999);
    expect(() => assertFamilyConsistent(characters, [...relations, relation(characters.at(-1)!.id, characters[0].id)])).toThrow(/цикл/);
  });
});
