import assert from "node:assert/strict";
import test from "node:test";

import type { Cadence, EvidenceDay } from "./types";
import { commitmentDays, dayCounts, declaredDays, evidenceDoneDays, namesDays, strip, stripCount, stripDays } from "./constancy";

const daily: Cadence = { kind: "daily" };
const day = (iso: string, quantity: number): EvidenceDay => ({ day: iso, quantity, unit: "minutos", labelKey: "sources.timelogVsCode" as never });

test("the strip is thirty days ending today, oldest first", () => {
  const days = stripDays("2026-10-31");
  assert.equal(days.length, 30);
  assert.equal(days[0], "2026-10-02");
  assert.equal(days[29], "2026-10-31");
});

test("a day before the commitment was written is neither done nor open, even if a source saw it", () => {
  const cells = strip("2026-10-31", { cadence: daily, createdOn: "2026-10-20" }, [{ day: "2026-10-25", by: "declared" }, { day: "2026-10-31", by: "evidence" }]);
  assert.equal(cells[0].state, "before");
  assert.equal(cells.find((cell) => cell.day === "2026-10-20")?.state, "open");
  assert.equal(cells.find((cell) => cell.day === "2026-10-25")?.state, "declared");
  assert.equal(cells.find((cell) => cell.day === "2026-10-31")?.state, "evidence");
  assert.deepEqual(stripCount(cells, daily), { done: 2, of: 12 });
});

test("a cadence that names weekdays counts and draws only those days; the rest are neutral", () => {
  const weekdays: Cadence = { kind: "weekdays", days: [1, 2, 3, 4, 5] };
  // 2026-10-31 is a Saturday.
  const cells = strip("2026-10-31", { cadence: weekdays, createdOn: "2026-01-01" }, []);
  assert.equal(cells[29].state, "neutral");
  assert.equal(cells[23].state, "neutral");
  assert.equal(cells[28].state, "open");
  const asked = cells.filter((cell) => cell.state === "open").length;
  assert.deepEqual(stripCount(cells, weekdays), { done: 0, of: asked });
  assert.ok(asked < 30 && asked > 15);
});

test("a count by the week names no day: no «of», the days done alone", () => {
  const weekly: Cadence = { kind: "times_per_week", count: 3 };
  assert.equal(namesDays(weekly), false);
  const cells = strip("2026-10-31", { cadence: weekly, createdOn: "2026-01-01" }, [{ day: "2026-10-30", by: "declared" }]);
  assert.equal(cells.filter((cell) => cell.state === "open").length, 0);
  assert.deepEqual(stripCount(cells, weekly), { done: 1, of: null });
});

test("a quantity written under its target is partial, never done", () => {
  const days = declaredDays(
    [{ day: "2026-10-30", quantity: 10 }, { day: "2026-10-30", quantity: 5 }, { day: "2026-10-31", quantity: 30 }],
    { kind: "quantity", target: 30, unit: "minutos" },
  );
  assert.deepEqual(days.map((entry) => [entry.day, entry.quantity, entry.by]), [["2026-10-30", 15, "partial"], ["2026-10-31", 30, "declared"]]);
  const cells = strip("2026-10-31", { cadence: daily, createdOn: "2026-01-01" }, days);
  assert.equal(cells[28].state, "partial");
  assert.deepEqual(stripCount(cells, daily), { done: 1, of: 30 });
  assert.equal(declaredDays([{ day: "2026-10-30", quantity: null }], { kind: "tap" })[0].by, "declared");
});

test("evidence counts from the day the commitment was written, at or over its threshold", () => {
  const read = { timelog_app_vscode: [day("2026-10-01", 200), day("2026-10-29", 89), day("2026-10-30", 120), day("2026-10-31", 95)] };
  const days = evidenceDoneDays({ sourceKey: "timelog_app_vscode", threshold: 90, createdOn: "2026-10-30" }, read, "2026-10-31");
  assert.deepEqual(days.map((entry) => entry.day), ["2026-10-30", "2026-10-31"]);
  assert.deepEqual(evidenceDoneDays({ sourceKey: null, threshold: 1, createdOn: "2026-01-01" }, {}, "2026-10-31"), []);
  assert.deepEqual(evidenceDoneDays({ sourceKey: "x", threshold: 1, createdOn: "2026-01-01" }, null, "2026-10-31"), []);
});

test("one merge: declared and evidence apart in the counts, one entry a day in the window, the declared one winning", () => {
  const out = commitmentDays({
    satisfiedBy: { kind: "evidence", threshold: 90, unit: "minutos" },
    sourceKey: "k",
    createdOn: "2026-06-01",
    today: "2026-10-31",
    declaredDayCount: 1,
    recent: [{ day: "2026-10-30", quantity: null }],
    evidence: { k: [day("2026-06-02", 100), day("2026-10-30", 100), day("2026-10-31", 100)] },
  });
  assert.equal(out.declaredDayCount, 1);
  assert.equal(out.evidenceDayCount, 3);
  assert.deepEqual(out.done.map((entry) => [entry.day, entry.by]), [["2026-10-31", "evidence"], ["2026-10-30", "declared"]]);
});

test("the month's counts take a source only through a commitment that names it, at that commitment's threshold", () => {
  const commitments = [
    { id: "a", satisfiedBy: { kind: "evidence" as const, threshold: 90, unit: "minutos" }, sourceKey: "vscode", createdOn: "2026-10-01" },
    { id: "b", satisfiedBy: { kind: "quantity" as const, target: 30, unit: "minutos" }, sourceKey: null, createdOn: "2026-10-01" },
    { id: "c", satisfiedBy: { kind: "tap" as const }, sourceKey: null, createdOn: "2026-10-01" },
  ];
  const facts = [
    { commitment_id: "b", day: "2026-10-05", quantity: 10 },
    { commitment_id: "b", day: "2026-10-06", quantity: 30 },
    { commitment_id: "c", day: "2026-10-06", quantity: null },
    { commitment_id: null, day: "2026-10-06", quantity: null },
  ];
  const read = {
    vscode: [day("2026-10-05", 89), day("2026-10-06", 91), day("2026-11-01", 500)],
    browsers: [day("2026-10-05", 600), day("2026-10-07", 600)],
  };
  assert.deepEqual(dayCounts(commitments, facts, read, "2026-10-01", "2026-10-31"), { "2026-10-06": 3 });
  assert.deepEqual(dayCounts(commitments, facts, null, "2026-10-01", "2026-10-31"), { "2026-10-06": 2 });
});

test("a day its source read under the threshold is listed in part with its minutes, and counts as no day done", () => {
  const found = commitmentDays({
    satisfiedBy: { kind: "evidence", threshold: 30, unit: "minutos" },
    sourceKey: "timelog_vscode",
    createdOn: "2026-10-01",
    today: "2026-10-31",
    declaredDayCount: 0,
    recent: [],
    evidence: { timelog_vscode: [day("2026-10-29", 14), day("2026-10-30", 45), day("2026-10-28", 0)] },
  });
  assert.deepEqual(found.done, [
    { day: "2026-10-30", quantity: 45, by: "evidence" },
    { day: "2026-10-29", quantity: 14, by: "partial" },
  ]);
  assert.equal(found.evidenceDayCount, 1);
});
