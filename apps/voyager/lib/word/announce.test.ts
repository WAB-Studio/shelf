import assert from "node:assert/strict";
import { test } from "node:test";

import { announce, type AnnounceInput } from "./announce";

const base: AnnounceInput = {
  kind: "word",
  senseCount: null,
  suggesting: false,
  network: "absent",
  decoration: "absent",
  phrase: "idle",
};

test("a found entry says how many senses it has", () => {
  assert.deepEqual(announce({ ...base, senseCount: 3 }).polite, { key: "senses", count: 3 });
});

test("a late network answer outranks the sense count", () => {
  assert.equal(announce({ ...base, senseCount: 2, network: "resolved" }).polite?.key, "networkReady");
  assert.equal(announce({ ...base, senseCount: 2, decoration: "resolved" }).polite?.key, "extraReady");
});

test("only a failure is assertive", () => {
  assert.equal(announce({ ...base, network: "failed" }).assertive, "networkFailed");
  assert.equal(announce({ ...base, senseCount: 1 }).assertive, null);
  assert.equal(announce({ ...base, kind: "phrase", phrase: "done" }).assertive, null);
});

test("a mid-word prefix and an empty box say nothing", () => {
  assert.deepEqual(announce({ ...base, suggesting: true }), { polite: null, assertive: null });
  assert.deepEqual(announce({ ...base, kind: "empty" }), { polite: null, assertive: null });
});

test("a word nobody has says there is no entry", () => {
  assert.equal(announce(base).polite?.key, "noEntry");
});

test("a phrase announces its translation stages", () => {
  assert.equal(announce({ ...base, kind: "phrase", phrase: "translating" }).polite?.key, "translating");
  assert.equal(announce({ ...base, kind: "phrase", phrase: "done" }).polite?.key, "phraseDone");
  assert.equal(announce({ ...base, kind: "phrase", phrase: "waiting" }).polite, null);
});
