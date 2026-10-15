// RL-59: the offline table of function-word translations. Asserted on the
// contract (what a reader gets for a word), not on how the table is stored.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FUNCTION_WORDS, functionWordTranslation } from "./function-words";

test("the words the board fixes read as drawn", () => {
  assert.ok(functionWordTranslation("something")?.includes("algo"));
  assert.equal(functionWordTranslation("nobody"), "nadie");
  assert.equal(functionWordTranslation("she"), "ella");
  assert.equal(functionWordTranslation("the"), "el, la");
});

test("a token is normalised before the lookup", () => {
  assert.equal(functionWordTranslation("Something"), functionWordTranslation("something"));
  assert.equal(functionWordTranslation(" the "), "el, la");
  assert.equal(functionWordTranslation("The,"), "el, la");
});

test("a word outside the table answers null", () => {
  assert.equal(functionWordTranslation("apple"), null);
  assert.equal(functionWordTranslation(""), null);
});

test("the table holds about a hundred well-formed entries", () => {
  assert.ok(FUNCTION_WORDS.size >= 90 && FUNCTION_WORDS.size <= 130, `size ${FUNCTION_WORDS.size}`);
  const source = readFileSync(new URL("./function-words.ts", import.meta.url), "utf8");
  const written = [...source.matchAll(/^ {2}\["([^"]+)", "/gm)].map((m) => m[1]);
  assert.equal(new Set(written).size, written.length, "duplicate key");
  assert.equal(written.length, FUNCTION_WORDS.size);
  for (const [word, translation] of FUNCTION_WORDS) {
    assert.ok(translation.trim().length > 0, `${word} has no translation`);
    assert.ok(translation.split(", ").length <= 2, `${word} has more than two glosses`);
  }
});
