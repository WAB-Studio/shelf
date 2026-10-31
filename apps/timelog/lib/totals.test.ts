import assert from "node:assert/strict";
import { test } from "node:test";

import { percent } from "./totals";

test("a share reads as a whole percent and never passes a hundred", () => {
  assert.equal(percent(16_080, 50_280), 32);
  assert.equal(percent(0, 100), 0);
  assert.equal(percent(5, 0), 0);
  assert.equal(percent(200, 100), 100);
});
