import assert from "node:assert/strict";
import test from "node:test";

import { evidenceDoneDays, mergeDoneDays, strip, stripCount, stripDays } from "./constancy";

test("the strip is thirty days ending today, oldest first", () => {
  const days = stripDays("2026-10-31");
  assert.equal(days.length, 30);
  assert.equal(days[0], "2026-10-02");
  assert.equal(days[29], "2026-10-31");
});

test("a day before the commitment was written is neither done nor open", () => {
  const cells = strip("2026-10-31", "2026-10-20", [{ day: "2026-10-25", by: "declared" }, { day: "2026-10-31", by: "evidence" }]);
  assert.equal(cells[0].state, "before");
  assert.equal(cells.find((cell) => cell.day === "2026-10-20")?.state, "open");
  assert.equal(cells.find((cell) => cell.day === "2026-10-25")?.state, "declared");
  assert.equal(cells.find((cell) => cell.day === "2026-10-31")?.state, "evidence");
  assert.deepEqual(stripCount(cells), { done: 2, of: 12 });
});

test("a commitment older than the strip counts against thirty days", () => {
  const cells = strip("2026-10-31", "2026-01-01", Array.from({ length: 26 }, (_, i) => ({ day: stripDays("2026-10-31")[i], by: "declared" as const })));
  assert.deepEqual(stripCount(cells), { done: 26, of: 30 });
});

test("evidence meets the threshold or the day is not done", () => {
  const days = evidenceDoneDays(
    { sourceKey: "timelog_app_vscode", threshold: 90 },
    {
      timelog_app_vscode: [
        { day: "2026-10-29", quantity: 89, unit: "minutos", labelKey: "sources.timelog_app_vscode" as never },
        { day: "2026-10-30", quantity: 120, unit: "minutos", labelKey: "sources.timelog_app_vscode" as never },
      ],
    },
  );
  assert.deepEqual(days, [{ day: "2026-10-30", quantity: 120, by: "evidence" }]);
  assert.deepEqual(evidenceDoneDays({ sourceKey: null, threshold: 1 }, {}), []);
});

test("a day written and read counts once, the declared one winning", () => {
  const merged = mergeDoneDays(
    [{ day: "2026-10-30", quantity: 15, by: "declared" }],
    [
      { day: "2026-10-30", quantity: 100, by: "evidence" },
      { day: "2026-10-31", quantity: 95, by: "evidence" },
    ],
  );
  assert.deepEqual(merged.map((entry) => [entry.day, entry.by]), [["2026-10-31", "evidence"], ["2026-10-30", "declared"]]);
});
