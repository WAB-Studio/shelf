import assert from "node:assert/strict";
import test from "node:test";

import { branchOf, buildTree, rollUp, rootOf, spanStart } from "./tree";
import type { GoalMonths, MonthFigure, TreeRow } from "./tree";

function row(id: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    id,
    parentId: null,
    position: 0,
    createdAt: "2026-05-01T15:00:00Z",
    name: `name-${id}`,
    horizon: "2027-01-01",
    archivedAt: null,
    measureUnit: null,
    ...over,
  };
}

// G > (g1 > p), g2 ; R stands alone.
function family(): TreeRow[] {
  return [
    row("g2", { parentId: "G", position: 1 }),
    row("p", { parentId: "g1" }),
    row("R", { position: 5 }),
    row("g1", { parentId: "G", position: 0 }),
    row("G"),
  ];
}

const M = "2026-10-01";
const M2 = "2026-11-01";

function fig(planned: number | null, reached: number): MonthFigure {
  return { planned, reached, ownBudget: true };
}
function own(unit: string | null, months: Record<string, [number | null, number]>): GoalMonths {
  return { unit, months: new Map(Object.entries(months).map(([k, [p, r]]) => [k, fig(p, r)])) };
}
function figure(map: Map<string, { months: Map<string, MonthFigure> }>, id: string, month: string) {
  const f = map.get(id)?.months.get(month);
  return f ? { planned: f.planned, reached: f.reached } : undefined;
}

test("preorder: siblings by position, not by creation; a child follows its parent", () => {
  // Kills: sort siblings by createdAt.
  const rows = [
    row("G"),
    row("late", { parentId: "G", position: 0, createdAt: "2026-09-01T15:00:00Z" }),
    row("early", { parentId: "G", position: 1, createdAt: "2026-02-01T15:00:00Z" }),
    row("kid", { parentId: "late" }),
  ];
  const { order } = buildTree(rows);
  assert.deepEqual(order.map((n) => n.id), ["G", "late", "kid", "early"]);
});

test("siblings tie on position by createdAt, then by id", () => {
  // Kills: dropping the createdAt or id tie-break.
  const { order } = buildTree([
    row("G"),
    row("c", { parentId: "G", createdAt: "2026-03-01T15:00:00Z" }),
    row("b", { parentId: "G", createdAt: "2026-03-01T15:00:00Z" }),
    row("a", { parentId: "G", createdAt: "2026-04-01T15:00:00Z" }),
  ]);
  assert.deepEqual(order.map((n) => n.id), ["G", "b", "c", "a"]);
});

test("a row whose parent is not among the rows is a root", () => {
  // Kills: dropping orphans, or keeping them at a depth below their missing parent.
  const { order, byId } = buildTree([row("o", { parentId: "ghost" }), row("k", { parentId: "o" })]);
  assert.deepEqual(order.map((n) => n.id), ["o", "k"]);
  assert.equal(byId.get("o")?.depth, 0);
  assert.deepEqual(byId.get("o")?.ancestors, []);
  assert.equal(byId.get("o")?.level, "general");
  assert.equal(byId.get("k")?.depth, 1);
});

test("level follows depth; a lone goal has none; a large goal without children stays large", () => {
  // Kills: deriving level from height (g2 would read «small»).
  const { byId } = buildTree(family());
  assert.equal(byId.get("G")?.level, "general");
  assert.equal(byId.get("g1")?.level, "large");
  assert.equal(byId.get("p")?.level, "small");
  assert.equal(byId.get("g2")?.level, "large");
  assert.equal(byId.get("R")?.level, null);
});

test("depth, height, ancestors and children are filled in", () => {
  // Kills: height or ancestors left at defaults.
  const { byId } = buildTree(family());
  const p = byId.get("p")!;
  assert.equal(p.depth, 2);
  assert.equal(p.height, 0);
  assert.deepEqual(p.ancestors.slice().sort(), ["G", "g1"]);
  assert.equal(byId.get("G")?.height, 2);
  assert.equal(byId.get("g1")?.height, 1);
  assert.deepEqual(byId.get("G")?.children, ["g1", "g2"]);
});

test("branchOf is the goal and everything below it, in tree order", () => {
  // Kills: direct children only.
  const tree = buildTree(family());
  assert.deepEqual(branchOf(tree, "G"), ["G", "g1", "p", "g2"]);
  assert.deepEqual(branchOf(tree, "g1"), ["g1", "p"]);
  assert.deepEqual(branchOf(tree, "R"), ["R"]);
});

test("rootOf climbs to the general goal", () => {
  // Kills: returning the direct parent.
  const tree = buildTree(family());
  assert.equal(rootOf(tree, "p"), "G");
  assert.equal(rootOf(tree, "G"), "G");
  assert.equal(rootOf(tree, "R"), "R");
});

test("spanStart is the earliest creation day of the branch, in Bogotá", () => {
  // Kills: always returning the goal's own creation day; reading the UTC day.
  const tree = buildTree([
    row("G", { createdAt: "2026-10-05T12:00:00Z" }),
    row("g1", { parentId: "G", createdAt: "2026-09-20T12:00:00Z" }),
    // 03:00Z on the 2nd is 22:00 on the 1st in Bogotá.
    row("p", { parentId: "g1", createdAt: "2026-09-02T03:00:00Z" }),
    row("R", { createdAt: "2026-07-01T20:00:00Z" }),
  ]);
  assert.equal(spanStart(tree, "G"), "2026-09-01");
  assert.equal(spanStart(tree, "g1"), "2026-09-01");
  assert.equal(spanStart(tree, "R"), "2026-07-01");
});

test("spanStart of a child ignores an older goal above it", () => {
  // Kills: folding ancestors into the span.
  const tree = buildTree([
    row("G", { createdAt: "2026-01-10T15:00:00Z" }),
    row("g1", { parentId: "G", createdAt: "2026-06-10T15:00:00Z" }),
  ]);
  assert.equal(spanStart(tree, "g1"), "2026-06-10");
});

test("rollUp sums every level, recursively, in the unit", () => {
  // Kills: summing direct children only (p would never reach G: 60/30 instead of 180/90).
  const rows = family().map((r) => ({ ...r, measureUnit: "min" }));
  const tree = buildTree(rows);
  const o = new Map<string, GoalMonths>([
    ["p", own("min", { [M]: [120, 60] })],
    ["g2", own("min", { [M]: [60, 30], [M2]: [10, 5] })],
  ]);
  const up = rollUp(tree, o);
  assert.deepEqual(figure(up, "g1", M), { planned: 120, reached: 60 });
  assert.deepEqual(figure(up, "G", M), { planned: 180, reached: 90 });
  assert.deepEqual(figure(up, "G", M2), { planned: 10, reached: 5 });
  assert.equal(up.has("p"), false);
  assert.equal(up.has("g2"), false);
  assert.equal(up.has("R"), false);
});

test("planned stays null when every child is null, and a 0 stays 0", () => {
  // Kills: `?? 0` per child (null would become 0).
  const rows = [
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
    row("b", { parentId: "G", measureUnit: "min", position: 1 }),
  ];
  const tree = buildTree(rows);
  const allNull = rollUp(tree, new Map([["a", own("min", { [M]: [null, 4] })], ["b", own("min", { [M]: [null, 6] })]]));
  assert.deepEqual(figure(allNull, "G", M), { planned: null, reached: 10 });
  const zero = rollUp(tree, new Map([["a", own("min", { [M]: [0, 0] })], ["b", own("min", { [M]: [null, 0] })]]));
  assert.deepEqual(figure(zero, "G", M), { planned: 0, reached: 0 });
});

test("a child in another unit adds nothing and is listed out of unit", () => {
  // Kills: summing regardless of unit; not listing the child.
  const tree = buildTree([
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
    row("b", { parentId: "G", measureUnit: "km", position: 1, name: "Correr" }),
  ]);
  const up = rollUp(tree, new Map([["a", own("min", { [M]: [100, 50] })], ["b", own("km", { [M]: [10, 5] })]]));
  assert.deepEqual(figure(up, "G", M), { planned: 100, reached: 50 });
  assert.deepEqual(up.get("G")?.outOfUnit, [{ id: "b", name: "Correr", unit: "km" }]);
});

test("a child with no measure adds nothing and is not listed", () => {
  // Kills: listing it out of unit; summing it.
  const tree = buildTree([
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
    row("n", { parentId: "G", measureUnit: null, position: 1 }),
  ]);
  const up = rollUp(tree, new Map([["a", own("min", { [M]: [100, 50] })], ["n", own(null, { [M]: [77, 33] })]]));
  assert.deepEqual(figure(up, "G", M), { planned: 100, reached: 50 });
  assert.deepEqual(up.get("G")?.outOfUnit, []);
});

test("a goal with no unit takes the first unit in tree order; the later one is out of unit", () => {
  // Kills: taking the last unit.
  const tree = buildTree([
    row("G"),
    row("a", { parentId: "G", measureUnit: "km", position: 0 }),
    row("b", { parentId: "G", measureUnit: "min", position: 1, name: "Leer" }),
  ]);
  const up = rollUp(tree, new Map([["a", own("km", { [M]: [30, 12] })], ["b", own("min", { [M]: [90, 40] })]]));
  assert.equal(up.get("G")?.unit, "km");
  assert.deepEqual(figure(up, "G", M), { planned: 30, reached: 12 });
  assert.deepEqual(up.get("G")?.outOfUnit, [{ id: "b", name: "Leer", unit: "min" }]);
});

test("a holder's own work adds to what it reached", () => {
  // Kills: ignoring own.get(G).
  const tree = buildTree([
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
  ]);
  const up = rollUp(tree, new Map([["a", own("min", { [M]: [120, 90] })], ["G", own("min", { [M]: [null, 15] })]]));
  assert.deepEqual(figure(up, "G", M), { planned: 120, reached: 105 });
});

test("an archived child adds nothing and is not listed", () => {
  // Kills: no archivedAt filter.
  const tree = buildTree([
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
    row("x", { parentId: "G", measureUnit: "min", position: 1, archivedAt: "2026-08-01T00:00:00Z" }),
    row("y", { parentId: "G", measureUnit: "km", position: 2, archivedAt: "2026-08-01T00:00:00Z" }),
  ]);
  const up = rollUp(
    tree,
    new Map([["a", own("min", { [M]: [100, 50] })], ["x", own("min", { [M]: [60, 30] })], ["y", own("km", { [M]: [9, 9] })]]),
  );
  assert.deepEqual(figure(up, "G", M), { planned: 100, reached: 50 });
  assert.deepEqual(up.get("G")?.outOfUnit, []);
});

test("spanStart ignores an archived goal, however early it was opened (RP-79, RP-83)", () => {
  // Kills: reading archived goals into the span.
  const tree = buildTree([
    row("G", { createdAt: "2026-10-05T12:00:00Z" }),
    row("old", { parentId: "G", createdAt: "2026-01-10T15:00:00Z", archivedAt: "2026-08-01T00:00:00Z" }),
    row("live", { parentId: "G", createdAt: "2026-09-01T15:00:00Z", position: 1 }),
  ]);
  assert.equal(spanStart(tree, "G"), "2026-09-01");
});

test("spanStart of a branch archived whole is its earliest day all the same (RP-83)", () => {
  // Kills: an empty span when no goal is open.
  const closed = "2026-08-01T00:00:00Z";
  const tree = buildTree([
    row("G", { createdAt: "2026-10-05T12:00:00Z", archivedAt: closed }),
    row("g1", { parentId: "G", createdAt: "2026-03-10T15:00:00Z", archivedAt: closed }),
  ]);
  assert.equal(spanStart(tree, "G"), "2026-03-10");
});

test("what a holder reached in another unit than its sum's adds nothing (RP-80)", () => {
  // Kills: adding the holder's own reached whatever its unit.
  const tree = buildTree([
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
  ]);
  const up = rollUp(tree, new Map([["a", own("min", { [M]: [120, 90] })], ["G", own("km", { [M]: [null, 15] })]]));
  assert.deepEqual(figure(up, "G", M), { planned: 120, reached: 90 });
});

test("a sum is never a typed amount, whatever its goals carried (RP-80)", () => {
  // Kills: passing a goal's ownBudget flag up to its holder.
  const tree = buildTree([
    row("G", { measureUnit: "min" }),
    row("a", { parentId: "G", measureUnit: "min" }),
  ]);
  const up = rollUp(tree, new Map([["a", own("min", { [M]: [120, 90] })]]));
  assert.equal(up.get("G")?.months.get(M)?.ownBudget, false);
});
