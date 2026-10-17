import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoryNamesById,
  scopedCategoryName,
  type NamedCategoryNode,
} from "./category-names";

const mark = (name: string) => `${name} · fondo`;

const nodes: NamedCategoryNode[] = [
  {
    id: "p1",
    name: "Mercado",
    scope: "personal",
    children: [{ id: "p1c", name: "Frutas" }],
  },
  {
    id: "g1",
    name: "Mercado",
    scope: "group",
    children: [{ id: "g1c", name: "Arriendo" }],
  },
];

describe("scopedCategoryName", () => {
  it("marks a fund name", () => {
    assert.equal(scopedCategoryName("Mercado", "group", mark), "Mercado · fondo");
  });

  it("leaves a personal name bare and never calls mark", () => {
    let calls = 0;
    const spy = (name: string) => {
      calls += 1;
      return mark(name);
    };
    assert.equal(scopedCategoryName("Mercado", "personal", spy), "Mercado");
    assert.equal(calls, 0);
  });
});

describe("categoryNamesById", () => {
  it("holds one entry per node, children inheriting the parent's scope", () => {
    const map = categoryNamesById(nodes, mark);
    assert.equal(map.size, 4);
    assert.equal(map.get("p1"), "Mercado");
    assert.equal(map.get("p1c"), "Frutas");
    assert.equal(map.get("g1"), "Mercado · fondo");
    assert.equal(map.get("g1c"), "Arriendo · fondo");
  });

  it("keeps same-named categories of two scopes apart", () => {
    const map = categoryNamesById(nodes, mark);
    assert.notEqual(map.get("p1"), map.get("g1"));
  });

  it("inserts parent before its children, in input order", () => {
    assert.deepEqual([...categoryNamesById(nodes, mark).keys()], [
      "p1",
      "p1c",
      "g1",
      "g1c",
    ]);
  });

  it("returns an empty map for no nodes", () => {
    assert.equal(categoryNamesById([], mark).size, 0);
  });
});
