// What the four edit/delete acts (RP-127) refuse before the server runs a statement. The bounds are
// RP-12's (7 a week, 365 days, 31 a month) and RP-15's phase rules; every message is a key the person
// can read, so each one is looked up in the Spanish catalogue.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { deleteCommitmentSchema, deletePhaseSchema, editCadenceSchema, editPhaseSchema } from "./plan-edit";

const id = "3f2b8f0e-1c1d-4b7a-9d3e-5a6b7c8d9e0f";

const planMessages = JSON.parse(readFileSync(resolve(process.cwd(), "messages/es/plan.json"), "utf8")) as {
  errors: Record<string, string>;
};

function keyExists(key: string): boolean {
  return key.startsWith("plan.errors.") && key.slice("plan.errors.".length) in planMessages.errors;
}

type Parser = { safeParse(input: unknown): { success: boolean; error?: { issues: { message: string }[] } } };

function issues(schema: Parser, input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error!.issues.map((issue) => issue.message);
}

const phase = { phaseId: id, aim: "Base", startsOn: "2099-01-05", endsOn: "2099-02-01" };

test("editPhase: a valid phase parses and the aim is trimmed", () => {
  const parsed = editPhaseSchema.safeParse({ ...phase, aim: "  Base aeróbica " });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.aim, "Base aeróbica");
});

test("editPhase: a malformed phase id is refused with one key the catalogue has, before the server", () => {
  const found = issues(editPhaseSchema, { ...phase, phaseId: "x" });
  assert.equal(found.length, 1, found.join(" | "));
  assert.ok(keyExists(found[0]), `${found[0]} is not in messages/es/plan.json`);
});

test("editPhase: the aim is refused empty or past 200, 200 passes", () => {
  assert.deepEqual(issues(editPhaseSchema, { ...phase, aim: "   " }), ["plan.errors.aimEmpty"]);
  assert.deepEqual(issues(editPhaseSchema, { ...phase, aim: "a".repeat(201) }), ["plan.errors.aimTooLong"]);
  assert.deepEqual(issues(editPhaseSchema, { ...phase, aim: "a".repeat(200) }), []);
});

test("editPhase: a day that is not a calendar day is refused on its own side", () => {
  // The act answers with the first issue.
  assert.equal(issues(editPhaseSchema, { ...phase, startsOn: "2099-02-30" })[0], "plan.errors.startsOnInvalid");
  assert.equal(issues(editPhaseSchema, { ...phase, endsOn: "mañana" })[0], "plan.errors.endsOnInvalid");
});

test("editPhase: a phase that ends before it starts is backwards, one that ends the day it starts is not", () => {
  assert.deepEqual(issues(editPhaseSchema, { ...phase, startsOn: "2099-02-02", endsOn: "2099-02-01" }), [
    "plan.errors.phaseBackwards",
  ]);
  assert.deepEqual(issues(editPhaseSchema, { ...phase, startsOn: "2099-02-01", endsOn: "2099-02-01" }), []);
});

test("deletePhase: a malformed id is refused, a uuid passes", () => {
  const found = issues(deletePhaseSchema, { phaseId: "x" });
  assert.equal(found.length, 1, found.join(" | "));
  assert.ok(keyExists(found[0]), `${found[0]} is not in messages/es/plan.json`);
  assert.deepEqual(issues(deletePhaseSchema, { phaseId: id }), []);
});

test("deleteCommitment: a malformed id is refused as an invalid commitment, a uuid passes", () => {
  assert.deepEqual(issues(deleteCommitmentSchema, { commitmentId: "x" }), ["plan.errors.commitmentInvalid"]);
  assert.deepEqual(issues(deleteCommitmentSchema, {}), ["plan.errors.commitmentInvalid"]);
  assert.deepEqual(issues(deleteCommitmentSchema, { commitmentId: id }), []);
});

test("editCadence: a malformed commitment id is refused as an invalid commitment", () => {
  assert.deepEqual(issues(editCadenceSchema, { commitmentId: "x", cadenceKind: "daily" }), [
    "plan.errors.commitmentInvalid",
  ]);
});

test("editCadence: times_per_week holds 1 to 7, 8 and 0 and a fraction are refused", () => {
  const input = (cadenceN: number) => ({ commitmentId: id, cadenceKind: "times_per_week", cadenceN });
  assert.deepEqual(issues(editCadenceSchema, input(8)), ["plan.errors.timesPerWeekInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, input(0)), ["plan.errors.timesPerWeekInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, input(2.5)), ["plan.errors.timesPerWeekInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, input(7)), []);
  assert.deepEqual(issues(editCadenceSchema, input(1)), []);
});

test("editCadence: every_n_days holds 1 to 365 and times_per_month 1 to 31", () => {
  const days = (cadenceN: number) => ({ commitmentId: id, cadenceKind: "every_n_days", cadenceN });
  assert.deepEqual(issues(editCadenceSchema, days(366)), ["plan.errors.everyNDaysInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, days(0)), ["plan.errors.everyNDaysInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, days(365)), []);
  const month = (cadenceN: number) => ({ commitmentId: id, cadenceKind: "times_per_month", cadenceN });
  assert.deepEqual(issues(editCadenceSchema, month(32)), ["plan.errors.timesPerMonthInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, month(0)), ["plan.errors.timesPerMonthInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, month(31)), []);
});

test("editCadence: weekdays asks for ISO days 1 to 7, at least one", () => {
  const weekdays = (cadenceWeekdays?: number[]) => ({ commitmentId: id, cadenceKind: "weekdays", cadenceWeekdays });
  assert.deepEqual(issues(editCadenceSchema, weekdays([])), ["plan.errors.weekdaysEmpty"]);
  assert.deepEqual(issues(editCadenceSchema, weekdays([0])), ["plan.errors.weekdayInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, weekdays([8])), ["plan.errors.weekdayInvalid"]);
  assert.deepEqual(issues(editCadenceSchema, weekdays([1, 3, 7])), []);
  assert.notDeepEqual(issues(editCadenceSchema, weekdays(undefined)), []);
});

test("editCadence: a counted kind with no count and an unknown kind are refused; daily needs nothing", () => {
  assert.notDeepEqual(issues(editCadenceSchema, { commitmentId: id, cadenceKind: "times_per_week" }), []);
  assert.notDeepEqual(issues(editCadenceSchema, { commitmentId: id, cadenceKind: "hourly" }), []);
  assert.deepEqual(issues(editCadenceSchema, { commitmentId: id, cadenceKind: "daily" }), []);
});

test("editCadence: what satisfies a commitment is not a field, so it is dropped", () => {
  const parsed = editCadenceSchema.safeParse({
    commitmentId: id,
    cadenceKind: "daily",
    satisfaction: "quantity",
    targetQuantity: 99,
    unit: "km",
  });
  assert.equal(parsed.success, true);
  const data = parsed.success ? (parsed.data as Record<string, unknown>) : {};
  assert.equal("satisfaction" in data, false);
  assert.equal("targetQuantity" in data, false);
  assert.equal("unit" in data, false);
});
