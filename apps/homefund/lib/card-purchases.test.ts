import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchPurchases, purchaseWindow } from "./card-purchases";

const booked = [
  { id: "a", occurredOn: "2026-11-03", amountCents: 45_000_00, currency: "COP" },
  { id: "b", occurredOn: "2026-11-10", amountCents: 12_990_00, currency: "COP" },
  { id: "c", occurredOn: "2026-11-10", amountCents: 12_990_00, currency: "USD" },
];

describe("matchPurchases", () => {
  it("matches the same amount and currency within two days either side", () => {
    const lines = [
      { occurredOn: "2026-11-05", amountCents: 45_000_00, currency: "COP" },
      { occurredOn: "2026-11-08", amountCents: 12_990_00, currency: "COP" },
    ];
    assert.deepEqual(matchPurchases(lines, booked), ["a", "b"]);
  });

  it("leaves a line three days away, or in another amount or currency, as new", () => {
    const lines = [
      { occurredOn: "2026-11-06", amountCents: 45_000_00, currency: "COP" },
      { occurredOn: "2026-11-10", amountCents: 12_991_00, currency: "COP" },
      { occurredOn: "2026-11-10", amountCents: 45_000_00, currency: "USD" },
    ];
    assert.deepEqual(matchPurchases(lines, booked), [null, null, null]);
  });

  it("answers a booked movement to one line only", () => {
    const twice = [
      { occurredOn: "2026-11-10", amountCents: 12_990_00, currency: "COP" },
      { occurredOn: "2026-11-10", amountCents: 12_990_00, currency: "COP" },
    ];
    assert.deepEqual(matchPurchases(twice, booked), ["b", null]);
  });

  it("takes the nearest day when two movements fit", () => {
    const near = [
      { id: "far", occurredOn: "2026-11-08", amountCents: 100, currency: "COP" },
      { id: "near", occurredOn: "2026-11-10", amountCents: 100, currency: "COP" },
    ];
    assert.deepEqual(matchPurchases([{ occurredOn: "2026-11-10", amountCents: 100, currency: "COP" }], near), ["near"]);
  });
});

describe("purchaseWindow", () => {
  it("widens the lines' span by two days each side, and is null without lines", () => {
    assert.deepEqual(
      purchaseWindow([
        { occurredOn: "2026-11-10", amountCents: 1, currency: "COP" },
        { occurredOn: "2026-11-01", amountCents: 1, currency: "COP" },
      ]),
      { from: "2026-10-30", to: "2026-11-12" },
    );
    assert.equal(purchaseWindow([]), null);
  });
});
