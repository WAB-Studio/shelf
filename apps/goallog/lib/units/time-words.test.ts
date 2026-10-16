import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "use-intl/core";

import units from "../../messages/es/units.json";
import { formatQuantity } from "./time";
import { timeWordsOf } from "./time-words";

const t = createTranslator({ locale: "es", messages: { units } });
const words = timeWordsOf(t as unknown as Parameters<typeof timeWordsOf>[0]);

test("a catalogue unit agrees with the count", () => {
  assert.equal(formatQuantity(60, "searches", words), "60 búsquedas");
});

test("one takes the singular", () => {
  assert.equal(formatQuantity(1, "searches", words), "1 búsqueda");
});

test("the unit is trimmed and lowercased before the lookup", () => {
  assert.equal(formatQuantity(60, " Searches ", words), "60 búsquedas");
});

test("a unit the catalogue lacks prints as typed", () => {
  assert.equal(formatQuantity(60, "km", words), "60 km");
  assert.equal(formatQuantity(3, "horas de estudio", words), "3 horas de estudio");
});

test("minutes print through the catalogue's h, min and join", () => {
  assert.equal(formatQuantity(750, "minutos", words), "12 h 30 min");
});

test("a free phrase is never looked up, even where every key answers", () => {
  const greedy = Object.assign((key: string) => `found:${key}`, { has: () => true });
  assert.equal(formatQuantity(3, "horas de estudio", timeWordsOf(greedy)), "3 horas de estudio");
});
