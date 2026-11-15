import assert from "node:assert/strict";
import { test } from "node:test";

import { agreedCategory, categoryFromHistory } from "./learned-category";

// Mutation: read every movement of the counterparty, so one old odd one outvotes the usual pair.
test("the two latest movements agree, or the counterparty is not learned", () => {
  assert.equal(agreedCategory(["rent", "rent"]), "rent");
  assert.equal(agreedCategory(["rent", "rent", "food"]), "rent");
  assert.equal(agreedCategory(["rent", "food"]), null);
  assert.equal(agreedCategory(["rent", "food", "rent"]), null);
});

// Mutation: demand two movements always, and a counterparty seen once is never learned.
test("a single movement counts when it is the only history, and none teaches nothing", () => {
  assert.equal(agreedCategory(["rent"]), "rent");
  assert.equal(agreedCategory([]), null);
});

// Mutation: say «history» for every merchant-sourced proposal, and a trusted merchant loses its own words.
test("a merchant-sourced proposal is from history only when no trusted merchant stands behind it", () => {
  assert.equal(categoryFromHistory({ categorySource: "merchant", merchantState: null }), true);
  assert.equal(categoryFromHistory({ categorySource: "merchant", merchantState: "learning" }), true);
  assert.equal(categoryFromHistory({ categorySource: "merchant", merchantState: "trusted" }), false);
  assert.equal(categoryFromHistory({ categorySource: "interpreter", merchantState: null }), false);
  assert.equal(categoryFromHistory({ categorySource: null, merchantState: null }), false);
});
