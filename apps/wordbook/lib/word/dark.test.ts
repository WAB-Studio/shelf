// W1: the one log line a dark paid route writes. Loaded under plain Node with
// no `server-only` stub, so a module that imports it fails here.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const real = { warn: console.warn, error: console.error, log: console.log };
let warns: unknown[][] = [];
let others = 0;

beforeEach(() => {
  warns = [];
  others = 0;
  console.warn = (...a: unknown[]) => void warns.push(a);
  console.error = () => void (others += 1);
  console.log = () => void (others += 1);
});
afterEach(() => Object.assign(console, real));

test("logDark writes exactly one console.warn naming the route and the reason, and nothing else", async () => {
  const { logDark } = await import("./dark");
  logDark("word/unlisted", "caller-cap");
  assert.deepEqual(warns, [["[paid-dark]", "word/unlisted", "caller-cap"]]);
  assert.equal(others, 0);
});

test("logDark names the sign-in budget the same way", async () => {
  const { logDark } = await import("./dark");
  logDark("signin", "no-caller");
  assert.deepEqual(warns, [["[paid-dark]", "signin", "no-caller"]]);
});
