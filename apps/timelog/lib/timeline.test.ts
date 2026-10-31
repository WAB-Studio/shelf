import assert from "node:assert/strict";
import { test } from "node:test";

import { focusShare, hourMarks, layoutSessions, minuteOfDay } from "./timeline";

// Bogotá is UTC-5 all year.
const at = (time: string) => new Date(`2026-10-30T${time}:00Z`);
const session = (key: string, from: string, to: string) => ({ key, label: key, first: at(from), last: at(to) });

test("a session sits on the line from 6:00 to 24:00 by Bogotá's clock", () => {
  assert.equal(minuteOfDay(at("14:30")), 9 * 60 + 30);
  const { startHour, segments } = layoutSessions([session("a", "14:00", "15:00")]);
  assert.equal(startHour, 6);
  const one = segments[0];
  assert.equal(one.lane, 0);
  assert.ok(Math.abs(one.left - (9 * 60 - 360) / 1080) < 1e-9);
  assert.ok(Math.abs(one.width - 60 / 1080) < 1e-9);
});

test("sessions that overlap take separate lanes and those that do not share one", () => {
  const { lanes, segments } = layoutSessions([session("a", "14:00", "16:00"), session("b", "15:00", "17:00"), session("c", "17:30", "18:00")]);
  assert.deepEqual(segments.map((one) => one.lane), [0, 1, 0]);
  assert.equal(lanes, 2);
});

test("a session before 6:00 pulls the line's start back to its hour", () => {
  const { startHour, segments } = layoutSessions([session("night", "05:01", "05:10")]);
  assert.equal(startHour, 0);
  assert.ok(Math.abs(segments[0].left - 1 / 1440) < 1e-9);
});

test("a very short session keeps a readable width and never runs past midnight", () => {
  const { segments } = layoutSessions([session("blink", "14:00", "14:00"), session("late", "04:30", "04:59")]);
  assert.ok(segments.every((one) => one.width >= 0.012 && one.left + one.width <= 1 + 1e-9));
});

test("the line opens at the hour now, else at the first session", () => {
  const layout = layoutSessions([session("a", "14:00", "15:00")]);
  assert.ok(Math.abs(focusShare(layout, 12 * 60) - 360 / 1080) < 1e-9);
  assert.ok(Math.abs(focusShare(layout, null) - (9 * 60 - 360) / 1080) < 1e-9);
  assert.equal(focusShare(layout, 2 * 60), 0);
});

test("hour marks run every three hours from the start", () => {
  assert.deepEqual(hourMarks(6).map((mark) => mark.hour), [6, 9, 12, 15, 18, 21, 24]);
  assert.equal(hourMarks(6)[0].left, 0);
  assert.equal(hourMarks(6).at(-1)?.left, 1);
  assert.deepEqual(hourMarks(0).map((mark) => mark.hour), [0, 3, 6, 9, 12, 15, 18, 21, 24]);
});
