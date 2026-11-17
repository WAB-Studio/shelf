import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planPocketCover, type CoverPocket } from "./pocket-cover";

const viajes: CoverPocket = { id: "v", name: "Viajes", balanceCents: 50_000_000, openedOn: "2026-01-01" };
const casa: CoverPocket = { id: "c", name: "Casa", balanceCents: 10_000_000, openedOn: "2026-01-01" };
const day = "2026-11-17";

describe("planPocketCover", () => {
  it("takes nothing while the free part covers the movement", () => {
    const plan = planPocketCover({ amountCents: 100, freeCents: 100, pockets: [viajes], occurredOn: day });
    assert.deepEqual(plan, { takes: [], totalCents: 0 });
  });

  it("takes only the shortfall from the largest pocket", () => {
    const plan = planPocketCover({
      amountCents: 140_000_000,
      freeCents: 110_000_000,
      pockets: [casa, viajes],
      occurredOn: day,
    });
    assert.deepEqual(plan, {
      takes: [{ id: "v", name: "Viajes", cents: 30_000_000 }],
      totalCents: 30_000_000,
    });
  });

  it("owes the whole amount when the free part is already below zero", () => {
    const plan = planPocketCover({ amountCents: 3_800_000, freeCents: -500, pockets: [viajes], occurredOn: day });
    assert.equal(plan.totalCents, 3_800_000);
  });

  it("spills into the next pocket and stops at what the pockets hold", () => {
    const plan = planPocketCover({
      amountCents: 100_000_000,
      freeCents: 0,
      pockets: [casa, viajes],
      occurredOn: day,
    });
    assert.deepEqual(
      plan.takes.map((take) => [take.name, take.cents]),
      [["Viajes", 50_000_000], ["Casa", 10_000_000]],
    );
    assert.equal(plan.totalCents, 60_000_000);
  });

  it("ignores a pocket opened after the movement's day", () => {
    const later = { ...viajes, openedOn: "2026-12-01" };
    assert.equal(planPocketCover({ amountCents: 100, freeCents: 0, pockets: [later], occurredOn: day }).totalCents, 0);
  });
});
