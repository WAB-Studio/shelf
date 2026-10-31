import assert from "node:assert/strict";
import { test } from "node:test";

import { groupByDay } from "./diary";

const at = (iso: string) => new Date(iso).getTime();

test("rows gather under today, yesterday and older days, newest day first", () => {
  const now = at("2026-10-31T15:00:00");
  const days = groupByDay(
    [
      { lastAt: at("2026-10-27T09:00:00"), count: 1, id: "d" },
      { lastAt: at("2026-10-31T08:00:00"), count: 4, id: "a" },
      { lastAt: at("2026-10-30T23:30:00"), count: 1, id: "c" },
      { lastAt: at("2026-10-31T14:00:00"), count: 2, id: "b" },
    ],
    now,
  );
  assert.deepEqual(days.map((day) => day.when), ["today", "yesterday", "other"]);
  assert.deepEqual(days[0].rows.map((row) => row.id), ["a", "b"]);
  assert.equal(days[2].rows[0].id, "d");
});

test("no rows, no days", () => {
  assert.deepEqual(groupByDay([], Date.now()), []);
});
