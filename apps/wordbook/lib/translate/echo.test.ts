import assert from "node:assert/strict";
import { test } from "node:test";

import { isEcho } from "./echo";

test("an echo with a trailing full stop is still an echo", () => {
  assert.equal(isEcho("I am looking forward to seeing you", "I am looking forward to seeing you."), true);
  assert.equal(isEcho("The cat", "  the   CAT! "), true);
});

test("a real translation is not an echo", () => {
  assert.equal(isEcho("the cat", "el gato"), false);
});
