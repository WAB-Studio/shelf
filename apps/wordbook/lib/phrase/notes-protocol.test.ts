// The notes gate admits a sentence the way a reader types it: contractions,
// the pronoun "I" and the article "a" included.
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanProviderText } from "@/lib/translate/clean";
import { admitPhrase, tokenisePhrase } from "./notes-protocol";

const TRANSLATION = "tengo muchas ganas de verte";

test("a contraction stays one token", () => {
  assert.deepEqual(tokenisePhrase("I'm looking forward"), ["I'm", "looking", "forward"]);
  assert.deepEqual(tokenisePhrase("I’m here"), ["I'm", "here"]);
});

test("a sentence with a contraction and a one-letter word is admitted", () => {
  assert.ok(admitPhrase("I'm looking forward to seeing you", TRANSLATION));
  assert.ok(admitPhrase("I have a dog", "tengo un perro"));
});

test("a stray symbol is still refused", () => {
  assert.equal(admitPhrase("I'm <b>looking</b> forward", TRANSLATION), null);
  assert.equal(admitPhrase("x y z", TRANSLATION), null);
});

test("the translation the route answers with is admitted: MyMemory's entity and line break are gone", () => {
  const answered = cleanProviderText("Es que ya no tengo tiempo.&#10;");
  assert.notEqual(admitPhrase("I'm running out of time", answered), null);
  assert.equal(admitPhrase("I'm running out of time", "Es que ya no tengo tiempo.&#10;"), null);
});
