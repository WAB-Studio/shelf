import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHeatmap } from "./heatmap";

const days = ["2026-10-26", "2026-10-27", "2026-10-28"];

test("the top apps of the week get a cell per day, levelled against the largest cell", () => {
  const map = buildHeatmap(
    [
      { day: "2026-10-26", app: "Code.exe", seconds: 4000 },
      { day: "2026-10-27", app: "Code.exe", seconds: 1000 },
      { day: "2026-10-26", app: "chrome.exe", seconds: 30 },
      { day: "2026-10-28", app: "chrome.exe", seconds: 2000 },
    ],
    days,
    "Sistema",
    8,
  );
  assert.deepEqual(map.rows.map((row) => [row.app, row.kind, row.total]), [["VS Code", "code", 5000], ["Chrome", "browser", 2030]]);
  assert.deepEqual(map.rows[0].cells, [{ seconds: 4000, level: 4 }, { seconds: 1000, level: 1 }, { seconds: 0, level: 0 }]);
  assert.deepEqual(map.rows[1].cells.map((cell) => cell.level), [1, 0, 2]);
  assert.equal(map.restCount, 0);
});

test("past the top, the rest is counted and its time added; system noise is one row", () => {
  const map = buildHeatmap(
    [
      { day: "2026-10-26", app: "Code.exe", seconds: 900 },
      { day: "2026-10-26", app: "chrome.exe", seconds: 600 },
      { day: "2026-10-26", app: "LockApp.exe", seconds: 100 },
      { day: "2026-10-27", app: "SearchHost.exe", seconds: 50 },
    ],
    days,
    "Sistema",
    2,
  );
  assert.deepEqual(map.rows.map((row) => row.app), ["VS Code", "Chrome"]);
  assert.equal(map.restCount, 1);
  assert.equal(map.restSeconds, 150);
  assert.equal(buildHeatmap([], days, "Sistema", 8).rows.length, 0);
});
