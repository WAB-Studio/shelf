import assert from "node:assert/strict";
import test from "node:test";

import { horizonRefusal } from "./horizon";
import { phaseWithinHorizon } from "./plan";

// The horizon is the first day after the goal (RP-11): the goal's last day is the one before it, and
// nothing a phase or a screen says may reach the horizon itself.
test("a phase may end the day before the horizon and not on it", () => {
  assert.equal(phaseWithinHorizon({ startsOn: "2026-12-26", endsOn: "2027-01-21" }, "2027-01-22"), true);
  assert.equal(phaseWithinHorizon({ startsOn: "2026-12-26", endsOn: "2027-01-22" }, "2027-01-22"), false);
});

test("a horizon on the day a phase ends is refused; the day after it is not", () => {
  const base = { today: "2026-10-31", lastPhaseEndsOn: "2027-01-22" };
  assert.equal(horizonRefusal({ ...base, horizon: "2027-01-22" }), "goal.errors.horizonBeforePhase");
  assert.equal(horizonRefusal({ ...base, horizon: "2027-01-23" }), null);
});
