import assert from "node:assert/strict";
import test from "node:test";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import dayMessages from "../../messages/es/day.json";
import {
  completeOneOffSchema,
  createOneOffSchema,
  fixTaskSchema,
  noteSchema,
  scheduleOneOffSchema,
  setOneOffNoteSchema,
} from "./one-off";

// RP-19: an errand's day is today or later, never one already gone.
function yesterday() {
  const d = civilDateToDate(todayInZone());
  d.setUTCDate(d.getUTCDate() - 1);
  return dateToCivilDate(d);
}

test("createOneOffSchema: a name of 120 characters is taken, 121 is refused", () => {
  assert.equal(createOneOffSchema.safeParse({ name: "a".repeat(120), day: null }).success, true);
  const long = createOneOffSchema.safeParse({ name: "a".repeat(121), day: null });
  assert.equal(long.success, false);
  assert.equal(long.error?.issues[0]?.message, "day.errors.oneOffNameTooLong");
});

test("createOneOffSchema: today is taken, yesterday is refused as past", () => {
  const today = todayInZone();
  assert.equal(createOneOffSchema.safeParse({ name: "x", day: today }).success, true);
  const past = createOneOffSchema.safeParse({ name: "x", day: yesterday() });
  assert.equal(past.success, false);
  assert.equal(past.error?.issues[0]?.message, "day.errors.oneOffDayPast");
});

test("createOneOffSchema: no day at all is a one-off with no day yet", () => {
  assert.equal(createOneOffSchema.safeParse({ name: "x", day: null }).success, true);
});

test("scheduleOneOffSchema: a day is required, today taken, yesterday refused", () => {
  const id = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  assert.equal(scheduleOneOffSchema.safeParse({ oneOffId: id, day: todayInZone() }).success, true);
  assert.equal(scheduleOneOffSchema.safeParse({ oneOffId: id, day: yesterday() }).success, false);
  assert.equal(scheduleOneOffSchema.safeParse({ oneOffId: id, day: null }).success, false);
});

const goalId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const parentId = "1b4e28ba-2fa1-4d2b-883f-0016d3cca427";

function refusal(input: unknown): string | undefined {
  const parsed = createOneOffSchema.safeParse(input);
  assert.equal(parsed.success, false, JSON.stringify(input));
  return parsed.error?.issues[0]?.message;
}

test("createOneOffSchema: a month task with an estimate, and a sub-task naming only its parent, are taken", () => {
  const task = createOneOffSchema.safeParse({ name: "x", day: null, goalId, plannedMonth: "2026-10", estimate: 90 });
  assert.equal(task.success, true);
  assert.equal(task.data?.estimate, 90);
  assert.equal(task.data?.plannedMonth, "2026-10");
  const child = createOneOffSchema.safeParse({ name: "x", day: null, parentId, estimate: 30 });
  assert.equal(child.success, true);
});

test("createOneOffSchema: an estimate of 0, 1.5 or 1 000 001 is refused; 1 and 1 000 000 are taken", () => {
  for (const estimate of [0, -1, 1.5, 1_000_001]) {
    assert.equal(refusal({ name: "x", day: null, goalId, estimate }), "month.errors.estimateInvalid");
  }
  for (const estimate of [1, 1_000_000]) {
    assert.equal(createOneOffSchema.safeParse({ name: "x", day: null, goalId, estimate }).success, true);
  }
});

test("createOneOffSchema: a 13th month or `2026-1` is refused", () => {
  for (const plannedMonth of ["2026-13", "2026-1", "2026-10-01"]) {
    assert.equal(refusal({ name: "x", day: null, goalId, plannedMonth }), "month.errors.monthInvalid");
  }
});

test("createOneOffSchema: a month needs a goal, and never comes with a day", () => {
  assert.equal(refusal({ name: "x", day: null, plannedMonth: "2026-10" }), "month.errors.invalid");
  assert.equal(
    refusal({ name: "x", day: todayInZone(), goalId, plannedMonth: "2026-10" }),
    "month.errors.invalid",
  );
});

test("createOneOffSchema: a sub-task names neither a month nor a goal", () => {
  assert.equal(refusal({ name: "x", day: null, parentId, plannedMonth: "2026-10" }), "month.errors.invalid");
  assert.equal(refusal({ name: "x", day: null, parentId, goalId }), "month.errors.invalid");
  assert.equal(refusal({ name: "x", day: null, parentId: "not-a-uuid" }), "month.errors.invalid");
});

test("createOneOffSchema: an estimate on a one-off of no goal measures nothing", () => {
  assert.equal(refusal({ name: "x", day: null, estimate: 30 }), "month.errors.noMeasure");
});

test("fixTaskSchema: an id and a YYYY-MM are taken; a day, a month 13 or a bad id are refused with their keys", () => {
  assert.equal(fixTaskSchema.safeParse({ oneOffId: parentId, month: "2026-11" }).success, true);
  for (const month of ["2026-11-01", "2026-13", "2026-1", ""]) {
    assert.equal(refusal2({ oneOffId: parentId, month }), "month.errors.monthInvalid");
  }
  assert.equal(refusal2({ oneOffId: "nope", month: "2026-11" }), "month.errors.invalid");
  assert.equal(fixTaskSchema.safeParse({ month: "2026-11" }).success, false);
});

function refusal2(input: unknown): string | undefined {
  const parsed = fixTaskSchema.safeParse(input);
  assert.equal(parsed.success, false, JSON.stringify(input));
  return parsed.error?.issues[0]?.message;
}

// RP-45: the note's one rule, shared by the act, the template and the AI.
test("noteSchema: 2000 characters pass, 2001 are refused with the key", () => {
  assert.equal(noteSchema.safeParse("a".repeat(2000)).success, true);
  const long = noteSchema.safeParse("a".repeat(2001));
  assert.equal(long.success, false);
  assert.equal(long.error?.issues[0]?.message, "day.errors.oneOffNoteTooLong");
});

test("noteSchema: blank is null, CRLF is LF, the ends are trimmed, null passes", () => {
  assert.equal(noteSchema.parse("  \n "), null);
  assert.equal(noteSchema.parse(""), null);
  assert.equal(noteSchema.parse("a\r\nb"), "a\nb");
  assert.equal(noteSchema.parse("  a\n\nb \n"), "a\n\nb");
  assert.equal(noteSchema.parse(null), null);
});

test("noteSchema: the length is judged after normalising", () => {
  assert.equal(noteSchema.safeParse(`${"a\r\n".repeat(1000)}`).success, true);
  assert.equal(noteSchema.safeParse(`  ${"a".repeat(2000)}  `).success, true);
});

test("setOneOffNoteSchema: an id and a note, the note parsed", () => {
  const id = "0b9f3d1e-6c1a-4a53-9a41-6f0a7d5d2c11";
  assert.deepEqual(setOneOffNoteSchema.parse({ oneOffId: id, note: " x " }), { oneOffId: id, note: "x" });
  assert.equal(setOneOffNoteSchema.safeParse({ oneOffId: "no", note: "x" }).success, false);
  assert.equal(setOneOffNoteSchema.safeParse({ oneOffId: id }).success, false);
});

test("createOneOffSchema: note is optional and parsed", () => {
  assert.equal(createOneOffSchema.parse({ name: "x", day: null }).note, undefined);
  assert.equal(createOneOffSchema.parse({ name: "x", day: null, note: " y " }).note, "y");
  assert.equal(createOneOffSchema.parse({ name: "x", day: null, note: "  " }).note, null);
});

// RP-129: the act of a task takes the day it was done on.
test("completeOneOffSchema: a real civil day is kept, no day stays absent, a malformed one is dayInvalid", () => {
  const id = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const kept = completeOneOffSchema.safeParse({ oneOffId: id, day: "2026-10-12" });
  assert.equal(kept.success, true);
  assert.equal(kept.data?.day, "2026-10-12");

  const bare = completeOneOffSchema.safeParse({ oneOffId: id });
  assert.equal(bare.success, true);
  assert.equal(bare.data?.day, undefined);

  for (const day of ["2026-13-40", "2026-02-30", "ayer", "", "2026-10-1", 20261012]) {
    const refused = completeOneOffSchema.safeParse({ oneOffId: id, day });
    assert.equal(refused.success, false, String(day));
    assert.equal(refused.error?.issues[0]?.message, "day.errors.dayInvalid", String(day));
  }
});

test("day.json: the task's two new refusals and the past heading read as the user decided; dayOnOneOff is gone", () => {
  // Read as plain records: the keys do not exist on the tree this is red on.
  const errors: Record<string, string> = dayMessages.errors;
  const done: Record<string, string> = dayMessages.doneOneOffs;
  assert.equal(errors.dayBeforeOneOff, "Esa tarea todavía no existía ese día.");
  assert.equal(errors.dayBeforeOneOffDay, "Esa tarea era para un día después.");
  assert.equal(done.titlePast, "Hechas ese día");
  assert.equal("dayOnOneOff" in errors, false);
});
