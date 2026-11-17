import assert from "node:assert/strict";
import { test } from "node:test";

import { holdsMoneyApartFromPockets, nameCarriesHolder } from "./account-detail";

test("a name that already says its holder is recognised without case or accents", () => {
  assert.equal(nameCarriesHolder("Mamá — BBVA", "Mamá"), true);
  assert.equal(nameCarriesHolder("MAMA - bbva", "Mamá"), true);
  assert.equal(nameCarriesHolder("Ahorros de Papá", "Papá"), true);
  assert.equal(nameCarriesHolder("Ana María Davivienda", "Ana María"), true);
});

test("a holder is a whole word: the name that merely contains its letters does not say it", () => {
  assert.equal(nameCarriesHolder("Banana Bank", "Ana"), false);
  assert.equal(nameCarriesHolder("BBVA", "Mamá"), false);
  assert.equal(nameCarriesHolder("Ana Davivienda", "Ana María"), false);
  assert.equal(nameCarriesHolder("BBVA", ""), false);
});

test("the free part is a line only when it differs from the total", () => {
  const cop = (balanceCents: number) => [{ currency: "COP", balanceCents }];
  assert.equal(holdsMoneyApartFromPockets(cop(100), undefined), false);
  assert.equal(holdsMoneyApartFromPockets(cop(100), cop(100)), false);
  assert.equal(holdsMoneyApartFromPockets(cop(100), cop(250)), true);
  assert.equal(holdsMoneyApartFromPockets([], cop(250)), true);
  assert.equal(holdsMoneyApartFromPockets([], []), false);
});
