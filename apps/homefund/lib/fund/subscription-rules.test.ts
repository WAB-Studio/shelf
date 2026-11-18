import assert from "node:assert/strict";
import { test } from "node:test";

import { readSubscription } from "./subscription-rules";

const TODAY = "2026-11-17";

test("a merchant charged the same amount every month is a subscription, with two charges already", () => {
  const netflix = readSubscription(
    [
      { date: "2026-10-08", cents: 44_900_00 },
      { date: "2026-11-08", cents: 44_900_00 },
    ],
    TODAY,
  );
  assert.deepEqual(netflix, {
    typicalCents: 44_900_00,
    occurrences: 2,
    firstDate: "2026-10-08",
    lastDate: "2026-11-08",
    nextExpected: "2026-12-08",
    active: true,
  });
});

test("trips of loose amounts on loose days are never a subscription", () => {
  const uber = readSubscription(
    [
      { date: "2026-10-06", cents: 18_500_00 },
      { date: "2026-10-14", cents: 22_000_00 },
      { date: "2026-11-04", cents: 16_800_00 },
      { date: "2026-11-12", cents: 24_300_00 },
    ],
    TODAY,
  );
  assert.equal(uber, null);
});

test("the same amount on a weekly rhythm is not a monthly subscription", () => {
  const weekly = [0, 7, 14, 21].map((back) => ({ date: `2026-10-${String(1 + back).padStart(2, "0")}`, cents: 10_000_00 }));
  assert.equal(readSubscription(weekly, TODAY), null);
});

test("an amount that drifts within ten percent still counts, one that drifts further does not", () => {
  const near = [
    { date: "2026-08-10", cents: 100_000_00 },
    { date: "2026-09-10", cents: 105_000_00 },
    { date: "2026-10-10", cents: 100_000_00 },
  ];
  assert.equal(readSubscription(near, TODAY)?.occurrences, 3);
  const far = [
    { date: "2026-08-10", cents: 100_000_00 },
    { date: "2026-09-10", cents: 140_000_00 },
    { date: "2026-10-10", cents: 180_000_00 },
  ];
  assert.equal(readSubscription(far, TODAY), null);
});

test("a subscription whose next charge is long overdue is no longer running", () => {
  const stopped = readSubscription(
    [
      { date: "2026-05-08", cents: 26_900_00 },
      { date: "2026-06-08", cents: 26_900_00 },
    ],
    TODAY,
  );
  assert.equal(stopped?.active, false);
});

test("one charge is not a series", () => {
  assert.equal(readSubscription([{ date: "2026-11-08", cents: 26_900_00 }], TODAY), null);
});
