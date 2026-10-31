import assert from "node:assert/strict";
import test from "node:test";

import { readerFor } from "./registry";
import { SOURCE_ROWS } from "./source-rows";
import { minutesPerDay, TIMELOG_SOURCES } from "./timelog-apps";
import { readableApp } from "./timelog-names";

const rows = [
  { day: "2026-10-01", app: "Code.exe", seconds: 3600 },
  { day: "2026-10-01", app: "WindowsTerminal.exe", seconds: 600 },
  { day: "2026-10-01", app: "LockApp.exe", seconds: 900 },
  { day: "2026-10-02", app: "chrome.exe", seconds: 1200 },
  { day: "2026-10-02", app: "msedge.exe", seconds: 600 },
  { day: "2026-10-03", app: "Code.exe", seconds: 20 },
];

test("an app is read under the name TimeLog shows", () => {
  assert.equal(readableApp("Code.exe"), "VS Code");
  assert.equal(readableApp("LockApp.exe"), null);
  assert.equal(readableApp("Obsidian.exe"), "Obsidian");
});

test("one app: its minutes per day, nothing for a day it was not open", () => {
  assert.deepEqual(minutesPerDay(rows, ["VS Code"]), [{ day: "2026-10-01", minutes: 60 }]);
});

test("a set of apps adds up on the day", () => {
  assert.deepEqual(minutesPerDay(rows, ["Chrome", "Edge"]), [{ day: "2026-10-02", minutes: 30 }]);
});

test("the total counts every row, system noise included, as TimeLog's own day does", () => {
  assert.deepEqual(minutesPerDay(rows, null), [
    { day: "2026-10-01", minutes: 85 },
    { day: "2026-10-02", minutes: 30 },
  ]);
});

test("every source is registered, seeded once and knows the fault seam", () => {
  for (const source of TIMELOG_SOURCES) {
    assert.ok(readerFor(source.key), source.key);
    assert.equal(SOURCE_ROWS.filter((row) => row.key === source.key).length, 1);
  }
  const saved = process.env.PULSAR_FAULT_SEAM;
  process.env.PULSAR_FAULT_SEAM = "timelog_total";
  try {
    const real = readerFor("timelog_app_vscode");
    const down = readerFor("timelog_total");
    assert.notEqual(down, real);
    return assert.rejects(() => (down as unknown as () => Promise<unknown>)(), /unreadable/);
  } finally {
    if (saved === undefined) delete process.env.PULSAR_FAULT_SEAM;
    else process.env.PULSAR_FAULT_SEAM = saved;
  }
});
