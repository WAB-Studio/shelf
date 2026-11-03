import assert from "node:assert/strict";
import test from "node:test";

import { planTrayEntries, uncoveredMinutes } from "./timelog-tray-plan";

const rows = [
  { day: "2026-10-01", app: "Code.exe", seconds: 3600 },
  { day: "2026-10-01", app: "WindowsTerminal.exe", seconds: 600 },
  { day: "2026-10-02", app: "Code.exe", seconds: 1200 },
];

test("with nothing covered the day's whole time goes to the tray", () => {
  assert.deepEqual(uncoveredMinutes(rows, []), [{ day: "2026-10-01", minutes: 70 }, { day: "2026-10-02", minutes: 20 }]);
});

test("a commitment on VS Code covers its minutes; the rest waits", () => {
  assert.deepEqual(uncoveredMinutes(rows, ["timelog_app_vscode"]), [{ day: "2026-10-01", minutes: 10 }]);
});

test("a commitment on the day's total covers everything", () => {
  assert.deepEqual(uncoveredMinutes(rows, ["timelog_total", "timelog_app_vscode"]), []);
});

test("a day with no entry opens one", () => {
  assert.deepEqual(planTrayEntries([{ day: "d1", minutes: 40 }], []), [{ kind: "insert", day: "d1", minutes: 40 }]);
});

test("the same minutes read again write nothing", () => {
  const entries = [{ id: "a", day: "d1", minutes: 40, waiting: true }];
  assert.deepEqual(planTrayEntries([{ day: "d1", minutes: 40 }], entries), []);
});

test("more time on a waiting entry's day moves that entry", () => {
  const entries = [{ id: "a", day: "d1", minutes: 40, waiting: true }];
  assert.deepEqual(planTrayEntries([{ day: "d1", minutes: 55 }], entries), [{ kind: "set", id: "a", minutes: 55 }]);
});

test("minutes already placed or dismissed are not entered twice; only the new ones open an entry", () => {
  const entries = [{ id: "a", day: "d1", minutes: 40, waiting: false }];
  assert.deepEqual(planTrayEntries([{ day: "d1", minutes: 55 }], entries), [{ kind: "insert", day: "d1", minutes: 15 }]);
  assert.deepEqual(planTrayEntries([{ day: "d1", minutes: 30 }], entries), []);
});

test("minutes a commitment now covers leave the waiting entry, and the entry with them when none remain", () => {
  const entries = [{ id: "a", day: "d1", minutes: 40, waiting: true }];
  assert.deepEqual(planTrayEntries([{ day: "d1", minutes: 10 }], entries), [{ kind: "set", id: "a", minutes: 10 }]);
  assert.deepEqual(planTrayEntries([], entries), [{ kind: "delete", id: "a" }]);
});
