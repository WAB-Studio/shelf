import assert from "node:assert/strict";
import test from "node:test";

import { branchEndsAfter, createInsideRefusal, horizonTreeRefusal, moveRefusal } from "./placement";
import { refusalKey, refusalName, REFUSAL_CODES } from "./refusal-key";
import { buildTree } from "./tree";
import type { TreeRow } from "./tree";
import { isClosed } from "@/lib/validation/closed";

const TODAY = "2026-10-13";

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

// D (dated) > d1 (no end) ; N (no end) > n1 (dated) ; N > n2 (no end) ; X dated alone ; Y no end alone.
function tree() {
  return buildTree([
    row("D", { horizon: "2027-01-01" }),
    row("d1", { parentId: "D", horizon: null }),
    row("N", { horizon: null, position: 1 }),
    row("n1", { parentId: "N", horizon: "2027-01-01" }),
    row("n2", { parentId: "N", horizon: null, position: 1 }),
    row("X", { horizon: "2027-06-01", position: 2 }),
    row("Y", { horizon: null, position: 3 }),
  ]);
}

test("isClosed: no end closes only by archive", () => {
  assert.equal(isClosed({ horizon: null, archivedAt: null }), false);
  assert.equal(isClosed({ horizon: null, archivedAt: "2026-10-01T00:00:00Z" }), true);
});

test("createInsideRefusal: no end under a dated goal names the goal above", () => {
  const r = createInsideRefusal(tree(), "X", null, TODAY);
  assert.equal(r?.code, "endPastAbove");
  assert.equal(r && "above" in r ? r.above.name : null, "name-X");
});

test("createInsideRefusal: a dated goal under one with no end, and no end under no end, pass", () => {
  assert.equal(createInsideRefusal(tree(), "Y", "2027-01-01", TODAY), null);
  assert.equal(createInsideRefusal(tree(), "Y", null, TODAY), null);
});

test("moveRefusal: a goal with no end under a dated one is refused; the other ways pass", () => {
  const t = tree();
  assert.equal(moveRefusal(t, "Y", "X", TODAY)?.code, "endPastAbove");
  assert.equal(moveRefusal(t, "X", "Y", TODAY), null);
  assert.equal(moveRefusal(t, "Y", "N", TODAY), null);
});

test("horizonTreeRefusal: giving an end to a goal holding one with none names that one", () => {
  const r = horizonTreeRefusal(tree(), "N", "2028-01-01");
  assert.equal(r?.code, "belowNoEnd");
  assert.equal(r && "below" in r ? r.below.name : null, "name-n2");
});

test("horizonTreeRefusal: removing the end under a dated goal is refused", () => {
  const r = horizonTreeRefusal(tree(), "d1", null);
  assert.equal(r?.code, "endPastAbove");
  assert.equal(r && "above" in r ? r.above.name : null, "name-D");
});

test("horizonTreeRefusal: removing the end of a free goal passes; belowEndsLater is as before", () => {
  const t = tree();
  assert.equal(horizonTreeRefusal(t, "X", null), null);
  assert.equal(horizonTreeRefusal(t, "n1", "2026-12-01"), null);
  assert.equal(horizonTreeRefusal(t, "N", "2026-12-01")?.code, "belowNoEnd");
});

test("belowNoEnd has its key and words", () => {
  assert.ok(REFUSAL_CODES.includes("belowNoEnd"));
  assert.equal(refusalKey("belowNoEnd"), "tree.errors.belowNoEnd");
  assert.equal(refusalName({ code: "belowNoEnd", below: { id: "a", name: "Caso", horizon: null } }), "Caso");
});

test("branchEndsAfter: nothing outlasts no end, so a branch moved to no end has no goal to pull along", () => {
  assert.deepEqual(branchEndsAfter(tree(), "D", null), []);
  assert.deepEqual(branchEndsAfter(tree(), "N", null), []);
});
