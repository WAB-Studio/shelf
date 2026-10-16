import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "use-intl";

import { sourceKey } from "../../i18n/translator";
import sources from "../../messages/es/sources.json";
import { knownSourceKeys } from "./registry";
import { SOURCE_ROWS } from "./source-rows";
import { evidenceUnitWords } from "./unit-words";

const real = createTranslator({ locale: "es", messages: { sources } }) as unknown as Parameters<
  typeof evidenceUnitWords
>[2];

// A second source, declared the way the next one will be: a row plus two
// message keys, and no component named anywhere.
const second = { labelKey: sourceKey("sources.fakeMinutes"), unit: "minutes" };
const fake = createTranslator({
  locale: "es",
  messages: {
    sources: { fakeMinutes: "lector", fakeMinutesUnit: "{count, plural, one {minuto} other {minutos}}" },
  },
}) as unknown as Parameters<typeof evidenceUnitWords>[2];

test("the reading source keeps its words, singular and plural", () => {
  const row = SOURCE_ROWS.find((r) => r.key === "reading_lookups")!;
  assert.equal(evidenceUnitWords(row, 1, real), "búsqueda");
  assert.equal(evidenceUnitWords(row, 2, real), "búsquedas");
  assert.equal(evidenceUnitWords(row, 0, real), "búsquedas");
});

test("a second source renders its own unit words through the same function", () => {
  assert.equal(evidenceUnitWords(second, 1, fake), "minuto");
  assert.equal(evidenceUnitWords(second, 5, fake), "minutos");
});

test("a source with no words reads as its raw unit", () => {
  assert.equal(evidenceUnitWords(second, 3, real), "minutes");
});

test("every declared row has words, and every reader has a row", () => {
  for (const row of SOURCE_ROWS) {
    assert.ok(row.labelKey.startsWith("sources."));
    const name = row.labelKey.slice("sources.".length);
    assert.ok(name in sources, `${name} missing`);
    assert.ok(`${name}Unit` in sources, `${name}Unit missing`);
  }
  assert.deepEqual([...SOURCE_ROWS.map((r) => r.key)].sort(), [...knownSourceKeys()].sort());
});
