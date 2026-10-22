import assert from "node:assert/strict";
import test from "node:test";

import { civilDate } from "./civil-date";
import { declareFactSchema } from "./fact";
import { scheduleOneOffSchema } from "./one-off";
import { createGoalSchema } from "./plan";

const issue = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, field: string) =>
  result.error?.issues.find((i) => i.path[0] === field)?.message;

test("civilDate refuses a day the calendar does not have, with the message it was given", () => {
  const schema = civilDate("some.message");
  assert.equal(schema.safeParse("2026-02-30").error?.issues[0].message, "some.message");
  assert.equal(schema.safeParse("2026-02-28").success, true);
});

test("each schema that takes a civil day refuses 2026-02-30 with its own message", () => {
  const uuid = "00000000-0000-4000-8000-000000000000";
  assert.equal(issue(createGoalSchema.safeParse({ name: "x", horizon: "2026-02-30" }), "horizon"), "plan.errors.horizonInvalid");
  assert.equal(issue(scheduleOneOffSchema.safeParse({ oneOffId: uuid, day: "2026-02-30" }), "day"), "day.errors.oneOffDayInvalid");
  assert.equal(issue(declareFactSchema.safeParse({ commitmentId: uuid, day: "2026-02-30" }), "day"), "day.errors.dayInvalid");
});
