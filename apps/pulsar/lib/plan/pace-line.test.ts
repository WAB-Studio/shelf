import assert from "node:assert/strict";
import { test } from "node:test";

import { showsPaceLine } from "./pace-line";

const open = { planned: 600, underPace: true, unreadable: false, ended: false };

test("an open goal under pace draws the pace line", () => {
  assert.equal(showsPaceLine(open), true);
});

test("an ended goal draws no pace line however far under pace", () => {
  assert.equal(showsPaceLine({ ...open, ended: true }), false);
});

test("no plan, an unreadable evidence or a goal on pace draws none", () => {
  assert.equal(showsPaceLine({ ...open, planned: null }), false);
  assert.equal(showsPaceLine({ ...open, planned: 0 }), false);
  assert.equal(showsPaceLine({ ...open, unreadable: true }), false);
  assert.equal(showsPaceLine({ ...open, underPace: false }), false);
});
