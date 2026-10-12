import assert from "node:assert/strict";
import test from "node:test";

import { createInsideRefusal, horizonTreeRefusal, moveRefusal, moveTargets, reopenRefusal } from "./placement";
import { buildTree } from "./tree";
import type { TreeRow } from "./tree";

const TODAY = "2026-10-12";

function row(id: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    id,
    parentId: null,
    position: 0,
    createdAt: "2026-05-01T15:00:00Z",
    name: `name-${id}`,
    horizon: "2030-01-01",
    archivedAt: null,
    measureUnit: null,
    ...over,
  };
}

// Horizon is the day after the goal's last day.
// G(2027-01-01) > g1(2026-12-01) > p(2026-11-01) ; G > g2(2026-12-15) > s(2026-11-01)
// X > L (a large, no children) ; R2(2026-11-01) ; R3(2026-12-01) ; A archived ; E ended today.
function rows(): TreeRow[] {
  return [
    row("G", { horizon: "2027-01-01" }),
    row("g1", { parentId: "G", position: 0, horizon: "2026-12-01" }),
    row("p", { parentId: "g1", horizon: "2026-11-01" }),
    row("g2", { parentId: "G", position: 1, horizon: "2026-12-15" }),
    row("s", { parentId: "g2", horizon: "2026-11-01" }),
    row("X"),
    row("L", { parentId: "X", horizon: "2029-01-01" }),
    row("R2", { horizon: "2026-11-01" }),
    row("R3", { horizon: "2026-12-01" }),
    row("A", { archivedAt: "2026-09-01T00:00:00Z" }),
    row("E", { horizon: TODAY }),
    row("R"),
  ];
}
const tree = () => buildTree(rows());
const ref = (id: string, name = `name-${id}`, horizon?: string) =>
  ({ id, name, horizon: horizon ?? rows().find((r) => r.id === id)!.horizon });

test("creating inside a small goal is refused as too deep", () => {
  // Kills: allowing depth 3.
  assert.deepEqual(createInsideRefusal(tree(), "p", "2026-10-30", TODAY), { code: "tooDeep" });
});

test("creating inside a general or a large goal is allowed", () => {
  // Kills: refusing at depth 1.
  assert.equal(createInsideRefusal(tree(), "G", "2026-12-01", TODAY), null);
  assert.equal(createInsideRefusal(tree(), "g1", "2026-11-30", TODAY), null);
});

test("a new goal ending after the one above is refused naming it; ending the same day is accepted", () => {
  // Kills: `>=` instead of `>`; wrong reference named.
  assert.deepEqual(createInsideRefusal(tree(), "G", "2027-01-02", TODAY), { code: "endPastAbove", above: ref("G") });
  assert.equal(createInsideRefusal(tree(), "G", "2027-01-01", TODAY), null);
});

test("creating inside an archived or an ended goal is refused naming it", () => {
  // Kills: looking only at archivedAt (E, ended today, would pass).
  assert.deepEqual(createInsideRefusal(tree(), "A", "2026-10-30", TODAY), { code: "aboveClosed", above: ref("A") });
  assert.deepEqual(createInsideRefusal(tree(), "E", "2026-10-12", TODAY), { code: "aboveClosed", above: ref("E") });
});

test("moving a goal under its own granddaughter is a cycle", () => {
  // Kills: not walking the destination's ancestors.
  assert.deepEqual(moveRefusal(tree(), "G", "p", TODAY), { code: "cycle" });
  assert.deepEqual(moveRefusal(tree(), "G", "g1", TODAY), { code: "cycle" });
  assert.deepEqual(moveRefusal(tree(), "G", "G", TODAY), { code: "cycle" });
});

test("a two-level branch under a large goal is too deep; a lone goal fits", () => {
  // Kills: ignoring the moved branch's height.
  assert.deepEqual(moveRefusal(tree(), "G", "L", TODAY), { code: "tooDeep" });
  assert.deepEqual(moveRefusal(tree(), "g1", "L", TODAY), { code: "tooDeep" });
  assert.equal(moveRefusal(tree(), "R", "L", TODAY), null);
  assert.equal(moveRefusal(tree(), "g1", "X", TODAY), null);
});

test("moving under a goal that ends earlier is refused naming it; the same end is accepted", () => {
  // Kills: `>=` instead of `>`.
  assert.deepEqual(moveRefusal(tree(), "g2", "R2", TODAY), { code: "endPastAbove", above: ref("R2") });
  assert.equal(moveRefusal(tree(), "g1", "R3", TODAY), null);
});

test("moving under an archived or an ended goal is refused naming it", () => {
  // Kills: looking only at archivedAt.
  assert.deepEqual(moveRefusal(tree(), "R", "A", TODAY), { code: "aboveClosed", above: ref("A") });
  assert.deepEqual(moveRefusal(tree(), "R", "E", TODAY), { code: "aboveClosed", above: ref("E") });
});

test("moving to the top is never refused", () => {
  // Kills: treating null as a destination.
  assert.equal(moveRefusal(tree(), "p", null, TODAY), null);
  assert.equal(moveRefusal(tree(), "G", null, TODAY), null);
  assert.equal(moveRefusal(tree(), "E", null, TODAY), null);
});

test("a horizon before a goal inside is refused naming the one ending latest", () => {
  // Kills: returning the first child instead of the latest.
  assert.deepEqual(horizonTreeRefusal(tree(), "G", "2026-12-10"), { code: "belowEndsLater", below: ref("g2") });
  assert.equal(horizonTreeRefusal(tree(), "G", "2026-12-15"), null);
  assert.equal(horizonTreeRefusal(tree(), "R", "2026-01-01"), null);
});

test("a horizon past the goal above is refused naming it", () => {
  // Kills: only checking the goals below.
  assert.deepEqual(horizonTreeRefusal(tree(), "g1", "2027-02-01"), { code: "endPastAbove", above: ref("G") });
  assert.equal(horizonTreeRefusal(tree(), "g1", "2027-01-01"), null);
});

test("reopening under an archived goal is refused naming it", () => {
  // Kills: no ancestor check.
  const archived = "2026-09-01T00:00:00Z";
  const t = buildTree([row("G", { archivedAt: archived }), row("g1", { parentId: "G", archivedAt: archived })]);
  assert.deepEqual(reopenRefusal(t, "g1"), { code: "aboveArchived", above: { id: "G", name: "name-G", horizon: "2030-01-01" } });
  assert.equal(reopenRefusal(t, "G"), null);
});

test("reopening under an open goal is allowed", () => {
  // Kills: refusing every archived child.
  const t = buildTree([row("G"), row("g1", { parentId: "G", archivedAt: "2026-09-01T00:00:00Z" })]);
  assert.equal(reopenRefusal(t, "g1"), null);
});

test("moveTargets marks the goal's own branch a cycle, deep goals too deep, and keeps the rest", () => {
  // Kills: returning every target unrefused.
  const by = new Map(moveTargets(tree(), "g1", TODAY).map((t) => [t.id, t.refusal]));
  assert.deepEqual(by.get("g1"), { code: "cycle" });
  assert.deepEqual(by.get("p"), { code: "cycle" });
  assert.deepEqual(by.get("s"), { code: "tooDeep" });
  assert.equal(by.get("R"), null);
  assert.equal(by.get("G"), null);
  assert.deepEqual(by.get("A"), { code: "aboveClosed", above: ref("A") });
});
