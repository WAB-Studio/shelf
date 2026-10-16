import assert from "node:assert/strict";
import test from "node:test";

import { screenPlanned } from "./screen-planned";

test("screenPlanned reads a rhythm-derived 0 as no amount, keeps a typed 0 and every other figure", () => {
  assert.equal(screenPlanned(0, false), null);
  assert.equal(screenPlanned(0, true), 0);
  assert.equal(screenPlanned(300, false), 300);
  assert.equal(screenPlanned(300, true), 300);
  assert.equal(screenPlanned(null, false), null);
});
