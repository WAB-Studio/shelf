import assert from "node:assert/strict";
import test from "node:test";

import { LIST_TAIL, tailOf } from "./tail";

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("a list of 11 or 12 rows is shown whole", () => {
  assert.equal(LIST_TAIL, 12);
  for (const n of [11, 12]) {
    const { shown, hidden } = tailOf(upTo(n), false);
    assert.equal(shown.length, n);
    assert.equal(hidden, 0);
  }
});

test("a longer list shows its last 12, in order", () => {
  const { shown, hidden } = tailOf(upTo(42), false);
  assert.deepEqual(shown, upTo(42).slice(30));
  assert.equal(shown[0], 31);
  assert.equal(shown[11], 42);
  assert.equal(hidden, 30);
});

test("all shows every row", () => {
  const { shown, hidden } = tailOf(upTo(42), true);
  assert.equal(shown.length, 42);
  assert.equal(hidden, 0);
});

test("an empty list hides nothing", () => {
  assert.deepEqual(tailOf([], false), { shown: [], hidden: 0 });
});
