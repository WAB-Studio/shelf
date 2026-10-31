import assert from "node:assert/strict";
import test from "node:test";

import { timeline } from "./timeline";

const phases = [
  { id: "a", name: "Base", startsOn: "2026-10-01", endsOn: "2026-10-30" },
  { id: "b", name: "Ritmo", startsOn: "2026-10-31", endsOn: "2026-11-29" },
];

test("phases are segments of one track and today is a mark on it", () => {
  const line = timeline({ openedOn: "2026-10-01", horizon: "2026-11-30", today: "2026-10-31", phases });
  assert.ok(line);
  assert.equal(line.segments[0].left, 0);
  assert.equal(Math.round(line.segments[0].width), 49);
  assert.equal(line.segments[0].state, "past");
  assert.equal(line.segments[1].state, "current");
  assert.equal(Math.round(line.today ?? -1), 49);
});

test("a goal with no end draws no timeline", () => {
  assert.equal(timeline({ openedOn: "2026-10-01", horizon: null, today: "2026-10-31", phases }), null);
});

test("today outside the span is no mark, and a coming phase is coming", () => {
  const before = timeline({ openedOn: "2026-10-01", horizon: "2026-11-30", today: "2026-09-20", phases });
  assert.equal(before?.today, null);
  assert.equal(before?.segments[0].state, "coming");
  const after = timeline({ openedOn: "2026-10-01", horizon: "2026-11-30", today: "2026-12-05", phases });
  assert.equal(after?.today, null);
  assert.equal(after?.lived, 100);
});
