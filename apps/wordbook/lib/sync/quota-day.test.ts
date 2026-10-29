import assert from "node:assert/strict";
import { test } from "node:test";

import { nextQuotaReset } from "./quota-day";

// The cap counts the UTC day (`sync_rows_today`), so the copy resumes at the
// next 00:00 UTC. `nextQuotaReset(nowMs)` answers that instant in epoch ms.
const utc = (iso: string): number => Date.parse(iso);

test("23:59:59 UTC resets at the 00:00 that follows, one second later", () => {
  assert.equal(nextQuotaReset(utc("2026-10-09T23:59:59.000Z")), utc("2026-10-10T00:00:00.000Z"));
});

test("00:00:00 UTC is already the new day: the reset is the next midnight, not now", () => {
  assert.equal(nextQuotaReset(utc("2026-10-10T00:00:00.000Z")), utc("2026-10-11T00:00:00.000Z"));
});

test("one millisecond before midnight still resets at that midnight", () => {
  assert.equal(nextQuotaReset(utc("2026-10-09T23:59:59.999Z")), utc("2026-10-10T00:00:00.000Z"));
});

test("midday resets at the coming midnight, never a day later", () => {
  assert.equal(nextQuotaReset(utc("2026-10-09T12:00:00.000Z")), utc("2026-10-10T00:00:00.000Z"));
});

test("month and year ends roll over, and a leap day exists", () => {
  assert.equal(nextQuotaReset(utc("2026-12-31T20:00:00.000Z")), utc("2027-01-01T00:00:00.000Z"));
  assert.equal(nextQuotaReset(utc("2028-02-28T10:00:00.000Z")), utc("2028-02-29T00:00:00.000Z"));
  assert.equal(nextQuotaReset(utc("2028-02-29T10:00:00.000Z")), utc("2028-03-01T00:00:00.000Z"));
});

test("the zone of the machine does not move it (a DST night in Madrid)", () => {
  assert.equal(nextQuotaReset(utc("2026-10-24T22:30:00.000Z")), utc("2026-10-25T00:00:00.000Z"));
  assert.equal(nextQuotaReset(utc("2026-10-25T00:30:00.000Z")), utc("2026-10-26T00:00:00.000Z"));
});

test("property: strictly after now, at most a day away, always on a UTC midnight", () => {
  let seed = 12345;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  for (let i = 0; i < 500; i++) {
    const now = utc("2024-01-01T00:00:00Z") + (next() % (4 * 365 * 86_400)) * 1000 + (next() % 1000);
    const reset = nextQuotaReset(now);
    assert.ok(reset > now, `${now}`);
    assert.ok(reset - now <= 86_400_000, `${now}`);
    assert.equal(reset % 86_400_000, 0, `${now}`);
  }
});
