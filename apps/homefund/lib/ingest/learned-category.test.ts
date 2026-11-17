import assert from "node:assert/strict";
import { test } from "node:test";

import { agreedCategory, categoryFromHistory, keywordCategory } from "./learned-category";

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

test("a merchant's name points at the person's own category of the movement's kind", () => {
  const categories = [
    { id: "housing", name: "Vivienda", kind: "expense" },
    { id: "groceries", name: "Mercado", kind: "expense" },
    { id: "transport", name: "Transporte", kind: "expense" },
    { id: "salary", name: "Salario", kind: "income" },
  ];

  assert.equal(keywordCategory("Exito Colina", "expense", categories), "groceries");
  assert.equal(keywordCategory("UBER TRIP", "expense", categories), "transport");
  assert.equal(keywordCategory("Nomina Acme", "income", categories), "salary");
  // A kind of the other side, an unknown merchant and a category the person never had name nothing.
  assert.equal(keywordCategory("Exito Colina", "income", categories), null);
  assert.equal(keywordCategory("Tienda de Ana", "expense", categories.slice(0, 1)), null);
  assert.equal(keywordCategory("Carlos Perez", "expense", categories), null);
  assert.equal(keywordCategory(null, "expense", categories), null);
});
