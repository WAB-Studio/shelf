import assert from "node:assert/strict";
import { test } from "node:test";

import { pickLocale } from "./locale";

test("the cookie wins over the browser", () => {
  assert.equal(pickLocale("en", "es-CO,es;q=0.9"), "en");
  assert.equal(pickLocale("es", "en-US"), "es");
});

test("without a cookie the first served language of the browser decides", () => {
  assert.equal(pickLocale(undefined, "en-US,en;q=0.9"), "en");
  assert.equal(pickLocale(undefined, "fr-FR,en;q=0.8"), "en");
  assert.equal(pickLocale(undefined, "es-CO"), "es");
});

test("anything else is Spanish", () => {
  assert.equal(pickLocale(undefined, null), "es");
  assert.equal(pickLocale("xx", "fr"), "es");
});
