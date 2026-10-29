import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoryNamesById,
  scopedCategoryName,
  scopedCategoryParts,
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

describe("scopedCategoryParts", () => {
  it("splits a fund name from the mark that follows it", () => {
    assert.deepEqual(scopedCategoryParts("Mercado", "group", mark), {
      name: "Mercado",
      suffix: " · fondo",
    });
  });

  it("leaves a personal name whole with no suffix and never calls mark", () => {
    let calls = 0;
    const spy = (name: string) => {
      calls += 1;
      return mark(name);
    };
    assert.deepEqual(scopedCategoryParts("Mercado", "personal", spy), {
      name: "Mercado",
      suffix: null,
    });
    assert.equal(calls, 0);
  });

  it("takes the suffix from what mark adds, not from the name's end", () => {
    const long = "x".repeat(60);
    assert.deepEqual(scopedCategoryParts(long, "group", mark), {
      name: long,
      suffix: " · fondo",
    });
    assert.deepEqual(scopedCategoryParts("Fondo", "group", (n) => `${n}!`), {
      name: "Fondo",
      suffix: "!",
    });
  });

  it("keeps the whole marked string as the name when the mark does not follow it", () => {
    assert.deepEqual(scopedCategoryParts("Mercado", "group", (n) => `Fondo: ${n}`), {
      name: "Fondo: Mercado",
      suffix: null,
    });
  });

  it("joins back to exactly what scopedCategoryName returns", () => {
    for (const scope of ["personal", "group"] as const) {
      const { name, suffix } = scopedCategoryParts("Mercado", scope, mark);
      assert.equal(name + (suffix ?? ""), scopedCategoryName("Mercado", scope, mark));
    }
  });
});
