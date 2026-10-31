import assert from "node:assert/strict";
import { test } from "node:test";

import { Bus, Fuel, Tag, Zap } from "lucide-react";

import { glyphFor } from "./category-tile";

test("«gas» is a whole word: gastos never wears the utilities' bolt", () => {
  assert.equal(glyphFor("Gas", false), Zap);
  assert.equal(glyphFor("Servicios y gas", false), Zap);
  assert.notEqual(glyphFor("Gastos varios", false), Zap);
  assert.equal(glyphFor("Gastos varios", false), Tag);
});

test("fuel reads before the utilities, in both languages", () => {
  assert.equal(glyphFor("Gasolina", false), Fuel);
  assert.equal(glyphFor("Gas station", false), Fuel);
  assert.equal(glyphFor("Fuel", false), Fuel);
});

test("the English transport seeds match", () => {
  assert.equal(glyphFor("Transport", false), Bus);
  assert.equal(glyphFor("Transportation", false), Bus);
  assert.equal(glyphFor("Transporte", false), Bus);
});
