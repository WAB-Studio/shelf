import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deferralStatus, instalmentShareCents } from "./deferral";

const plan = { amountCents: 1_000_000, instalments: 36, purchasedOn: "2026-03-15", clearedOn: null };

describe("instalmentShareCents", () => {
  it("splits in whole cents and gives the last instalment the remainder", () => {
    assert.equal(instalmentShareCents(1000, 3, 1), 333);
    assert.equal(instalmentShareCents(1000, 3, 2), 333);
    assert.equal(instalmentShareCents(1000, 3, 3), 334);
  });

  it("sums back to the whole amount", () => {
    const total = Array.from({ length: 7 }, (_, i) => instalmentShareCents(100_001, 7, i + 1)).reduce((a, b) => a + b);
    assert.equal(total, 100_001);
  });
});

describe("deferralStatus", () => {
  it("counts the purchase's own month as instalment 1", () => {
    assert.deepEqual(deferralStatus({ ...plan, today: "2026-03-31" }), {
      state: "running", current: 1, total: 36, shareCents: 27_777,
    });
  });

  it("advances by calendar month, not by day count", () => {
    assert.equal((deferralStatus({ ...plan, today: "2026-04-01" }) as { current: number }).current, 2);
    assert.equal((deferralStatus({ ...plan, today: "2027-01-02" }) as { current: number }).current, 11);
  });

  it("gives the last instalment the remainder and ends after it", () => {
    const last = deferralStatus({ ...plan, today: "2029-02-10" });
    assert.deepEqual(last, { state: "running", current: 36, total: 36, shareCents: 1_000_000 - 27_777 * 35 });
    assert.deepEqual(deferralStatus({ ...plan, today: "2029-03-01" }), { state: "extinguished" });
  });

  it("is extinguished once a payment brought the balance to zero or credit", () => {
    assert.deepEqual(deferralStatus({ ...plan, today: "2026-04-10", clearedOn: "2026-04-05" }), { state: "extinguished" });
  });
});
