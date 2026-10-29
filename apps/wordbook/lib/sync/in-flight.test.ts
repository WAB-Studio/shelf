import assert from "node:assert/strict";
import { test } from "node:test";

import { shareInFlight } from "./in-flight";

test("two calls before it resolves share one run and one promise", async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const shared = shareInFlight(async () => {
    runs++;
    await gate;
    return runs;
  });
  const a = shared();
  const b = shared();
  assert.equal(a, b);
  release();
  await a;
  assert.equal(runs, 1);
});

test("a call after it resolved runs again", async () => {
  let runs = 0;
  const shared = shareInFlight(async () => ++runs);
  const a = shared();
  const b = shared();
  await a;
  assert.equal(await shared(), 2);
  assert.equal(await b, 1);
});

test("a run that rejects does not stick", async () => {
  let runs = 0;
  const shared = shareInFlight(async () => {
    if (++runs === 1) throw new Error("boom");
    return runs;
  });
  await assert.rejects(shared(), /boom/);
  assert.equal(await shared(), 2);
});
