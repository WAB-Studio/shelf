import assert from "node:assert/strict";
import { test } from "node:test";

import {
  latestClosedPeriod,
  statementRequest,
  suggestsQuarterly,
  type StatementRequestInput,
} from "./statement-cadence";

const savings: StatementRequestInput = {
  statementCadence: "quarterly",
  dismissedThrough: null,
  addedOn: "2026-01-10",
  openedOn: "2026-01-01",
  latestReconciledOn: null,
  latestStatementCutOff: null,
};

test("quarterly is offered to Bancolombia savings only", () => {
  assert.equal(suggestsQuarterly({ institution: "Bancolombia", subtype: "bank" }), true);
  assert.equal(suggestsQuarterly({ institution: "bancolombia S.A.", subtype: "bank" }), true);
  assert.equal(suggestsQuarterly({ institution: "Nu", subtype: "bank" }), false);
  assert.equal(suggestsQuarterly({ institution: "Bancolombia", subtype: "card" }), false);
  assert.equal(suggestsQuarterly({ institution: null, subtype: "bank" }), false);
});

test("a period closes after its last day plus the grace", () => {
  assert.deepEqual(latestClosedPeriod("monthly", "2026-11-17"), { start: "2026-10-01", end: "2026-10-31" });
  // Grace not over on the 3rd: the month before still stands.
  assert.deepEqual(latestClosedPeriod("monthly", "2026-11-03"), { start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(latestClosedPeriod("monthly", "2026-11-04"), { start: "2026-10-01", end: "2026-10-31" });
  assert.deepEqual(latestClosedPeriod("quarterly", "2026-11-17"), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(latestClosedPeriod("quarterly", "2027-01-10"), { start: "2026-10-01", end: "2026-12-31" });
  assert.deepEqual(latestClosedPeriod("quarterly", "2027-01-02"), { start: "2026-07-01", end: "2026-09-30" });
});

test("a savings statement is asked for in January, April, July and October", () => {
  assert.equal(statementRequest(savings, "2026-10-10")?.end, "2026-09-30");
  assert.equal(statementRequest(savings, "2026-11-17")?.end, "2026-09-30");
  assert.equal(statementRequest(savings, "2027-01-10")?.end, "2026-12-31");
  assert.equal(statementRequest(savings, "2027-04-02")?.end, "2026-12-31");
});

test("the request stays until a statement or a count covers the period", () => {
  assert.notEqual(statementRequest(savings, "2026-11-17"), null);
  assert.equal(statementRequest({ ...savings, latestStatementCutOff: "2026-09-30" }, "2026-11-17"), null);
  assert.equal(statementRequest({ ...savings, latestReconciledOn: "2026-09-30" }, "2026-11-17"), null);
  assert.equal(statementRequest({ ...savings, latestReconciledOn: "2026-11-10" }, "2026-11-17"), null);
  assert.notEqual(statementRequest({ ...savings, latestReconciledOn: "2026-09-29" }, "2026-11-17"), null);
});

test("an account is asked for nothing when it has no cadence or was added after the period closed", () => {
  assert.equal(statementRequest({ ...savings, statementCadence: null }, "2026-11-17"), null);
  assert.equal(statementRequest({ ...savings, addedOn: "2026-11-01", openedOn: "2026-11-01" }, "2026-11-17"), null);
});

test("«Ahora no» hides the period it was said for, and the next period is asked for again", () => {
  assert.equal(statementRequest({ ...savings, dismissedThrough: "2026-09-30" }, "2026-11-17"), null);
  assert.notEqual(statementRequest({ ...savings, dismissedThrough: "2026-06-30" }, "2026-11-17"), null);
  assert.equal(statementRequest({ ...savings, dismissedThrough: "2026-09-30" }, "2027-01-10")?.end, "2026-12-31");
});
