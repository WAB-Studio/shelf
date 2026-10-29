// RL-52: only this device's own rows past the cursor are still to upload.
import assert from "node:assert/strict";
import { test } from "node:test";

import { countPending } from "./pending";

const own = (id: number) => ({ id });
const foreign = (id: number) => ({ id, device: "other" });

const rows = [own(2), own(5), foreign(6), own(8), foreign(9)];

test("countPending: counts own rows past the cursor and ignores other devices' rows", () => {
  assert.equal(countPending(rows, 4), 2);
});

test("countPending: a null cursor counts every own row", () => {
  assert.equal(countPending(rows, null), 3);
});

test("countPending: a row with a null device is own", () => {
  assert.equal(countPending([{ id: 5, device: null }], 4), 1);
});

test("countPending: a row at the cursor is already pushed", () => {
  assert.equal(countPending([own(4)], 4), 0);
});
