// What a person may declare, and on which day (RP-03, RP-04, RP-06): written from the contract. The reach into the
// past is seven days and the literal 7 is typed here, never read from the code, so a limit that drifts is a red.
import assert from "node:assert/strict";
import test from "node:test";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { declareFactSchema } from "./fact";

const COMMITMENT = "6f1f7f0e-3c1a-4a52-9d0e-0a6b1f1c2d3e";
const TASK = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function daysAgo(n: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() - n);
  return dateToCivilDate(date);
}

const keysOf = (input: unknown): string[] => {
  const parsed = declareFactSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

test("a fact reaches seven days back and no further (RP-06)", () => {
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(7) }), []);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(8) }), ["day.errors.dayTooOld"]);
  assert.deepEqual(keysOf({ oneOffId: TASK, day: daysAgo(7) }), []);
  assert.deepEqual(keysOf({ oneOffId: TASK, day: daysAgo(8) }), ["day.errors.dayTooOld"]);
});

test("a day after today is refused with its own key (RP-06)", () => {
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(-1) }), ["day.errors.dayFuture"]);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(0) }), []);
});

test("a tap on a Hoy drawn two days ago is stale; yesterday's screen still lands, and a picked day is not stale", () => {
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(0), onHoy: true }), []);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(1), onHoy: true }), []);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(2), onHoy: true }), ["day.errors.dayStale"]);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(6), onHoy: true }), ["day.errors.dayStale"]);
  // The same day, picked in the past-day sheet rather than tapped on Hoy, is within reach.
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, day: daysAgo(2) }), []);
});

test("a fact explains exactly one subject: neither and both are refused, either alone is not", () => {
  assert.deepEqual(keysOf({}), ["day.errors.subjectInvalid"]);
  assert.deepEqual(keysOf({ commitmentId: null, oneOffId: null }), ["day.errors.subjectInvalid"]);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, oneOffId: TASK }), ["day.errors.subjectInvalid"]);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT }), []);
  assert.deepEqual(keysOf({ oneOffId: TASK }), []);
});

test("a quantity is a whole number from 1 to 1,000,000", () => {
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, quantity: 1_000_000 }), []);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, quantity: 1_000_001 }), ["day.errors.quantityInvalid"]);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, quantity: 1 }), []);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, quantity: 0 }), ["day.errors.quantityInvalid"]);
  assert.deepEqual(keysOf({ commitmentId: COMMITMENT, quantity: 2.5 }), ["day.errors.quantityInvalid"]);
});
