import assert from "node:assert/strict";
import test from "node:test";

import { unreadableSources } from "./fault-seam";

test("the seam is off when the variable is unset or empty", () => {
  assert.equal(unreadableSources(undefined, undefined).size, 0);
  assert.equal(unreadableSources("", undefined).size, 0);
});

test("the seam names the one source it is given", () => {
  assert.deepEqual([...unreadableSources("reading_lookups", undefined)], ["reading_lookups"]);
});

test("production ignores the seam (VERCEL set)", () => {
  assert.equal(unreadableSources("reading_lookups", "1").size, 0);
});

test("two sources split on the comma", () => {
  assert.deepEqual(
    [...unreadableSources("reading_lookups,fake_minutes", undefined)].sort(),
    ["fake_minutes", "reading_lookups"],
  );
});

test("a space after the comma is not part of the key", () => {
  assert.deepEqual(
    [...unreadableSources("reading_lookups, fake_minutes", undefined)].sort(),
    ["fake_minutes", "reading_lookups"],
  );
  assert.deepEqual([...unreadableSources("  reading_lookups  ", undefined)], ["reading_lookups"]);
});
