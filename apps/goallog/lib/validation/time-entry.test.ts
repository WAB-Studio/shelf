import assert from "node:assert/strict";
import test from "node:test";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { confirmTimeEntrySchema, recordTimeEntrySchema, settlement, timeEntryIdSchema } from "./time-entry";

const entryId = "11111111-1111-4111-8111-111111111111";
const goalA = "22222222-2222-4222-8222-222222222222";
const goalB = "33333333-3333-4333-8333-333333333333";

test("confirmTimeEntrySchema: one allocation and a split are taken", () => {
  assert.equal(confirmTimeEntrySchema.safeParse({ entryId, allocations: [{ goalId: goalA, minutes: 120 }] }).success, true);
  assert.equal(
    confirmTimeEntrySchema.safeParse({
      entryId,
      allocations: [
        { goalId: goalA, minutes: 90 },
        { goalId: goalB, minutes: 30 },
      ],
    }).success,
    true,
  );
});

test("confirmTimeEntrySchema: no allocation, a repeated goal, zero or fractional minutes are refused", () => {
  const refused = (allocations: unknown) => confirmTimeEntrySchema.safeParse({ entryId, allocations });
  assert.equal(refused([]).error?.issues[0]?.message, "day.errors.timeAllocationInvalid");
  assert.equal(
    refused([
      { goalId: goalA, minutes: 10 },
      { goalId: goalA, minutes: 20 },
    ]).error?.issues[0]?.message,
    "day.errors.timeAllocationInvalid",
  );
  assert.equal(refused([{ goalId: goalA, minutes: 0 }]).success, false);
  assert.equal(refused([{ goalId: goalA, minutes: 1.5 }]).success, false);
});

test("timeEntryIdSchema: an id that is no uuid is refused", () => {
  assert.equal(timeEntryIdSchema.safeParse({ entryId: "x" }).success, false);
});

test("recordTimeEntrySchema: a chat entry with a day and minutes is taken, an unknown source is refused", () => {
  const day = dateToCivilDate(civilDateToDate(todayInZone()));
  assert.equal(recordTimeEntrySchema.safeParse({ day, minutes: 480, source: "chat", goalId: goalA }).success, true);
  assert.equal(recordTimeEntrySchema.safeParse({ day, minutes: 480, source: "task" }).success, false);
});

test("settlement: the allocations must add up to the entry", () => {
  assert.equal(settlement(120, [{ minutes: 90 }, { minutes: 30 }]), "exact");
  assert.equal(settlement(120, [{ minutes: 90 }]), "short");
  assert.equal(settlement(120, [{ minutes: 90 }, { minutes: 40 }]), "over");
});
