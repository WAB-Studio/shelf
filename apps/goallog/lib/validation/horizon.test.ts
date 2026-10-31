import assert from "node:assert/strict";
import test from "node:test";

import { horizonRefusal } from "./horizon";

const today = "2026-09-28";

test("horizonRefusal: today and earlier are past, the day after is not", () => {
  assert.equal(horizonRefusal({ horizon: today, today, lastPhaseEndsOn: null }), "goal.errors.horizonPast");
  assert.equal(horizonRefusal({ horizon: "2026-09-27", today, lastPhaseEndsOn: null }), "goal.errors.horizonPast");
  assert.equal(horizonRefusal({ horizon: "2026-09-29", today, lastPhaseEndsOn: null }), null);
});

test("horizonRefusal: a phase ending after the horizon refuses it, one ending on it does not", () => {
  const horizon = "2026-10-11";
  assert.equal(
    horizonRefusal({ horizon, today, lastPhaseEndsOn: "2026-10-12" }),
    "goal.errors.horizonBeforePhase",
  );
  assert.equal(horizonRefusal({ horizon, today, lastPhaseEndsOn: horizon }), null);
});

test("horizonRefusal: past wins over a stranded phase", () => {
  assert.equal(
    horizonRefusal({ horizon: today, today, lastPhaseEndsOn: "2026-10-12" }),
    "goal.errors.horizonPast",
  );
});
