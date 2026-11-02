import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeSources, claudeTotal, claudeWeekHint, dailyRows, sourcesOverlap, toCsv } from "./daily";

const totals = [
  { day: "2026-10-27", seconds: 20_000 },
  { day: "2026-10-29", seconds: 3_600 },
];
const claude = [{ day: "2026-10-27", code: 5_400, web: 1_200, desktop: 600 }];
const apps = [
  { day: "2026-10-27", app: "msedgewebview2.exe", seconds: 9_000 },
  { day: "2026-10-27", app: "Code.exe", seconds: 8_000 },
  { day: "2026-10-27", app: "chrome.exe", seconds: 3_000 },
  { day: "2026-10-29", app: "=HYPERLINK(1)", seconds: 3_600 },
];

test("Claude's total is Claude Code plus claude.ai plus the desktop app", () => {
  assert.equal(claudeTotal(claude[0]), 7_200);
});

test("a row per day from `from` to `to`, a day with nothing at zero", () => {
  const rows = dailyRows("2026-10-27", "2026-10-29", totals, claude, apps, "Sistema", "2026-10-31", new Set(["2026-10-27", "2026-10-28", "2026-10-29"]));
  assert.deepEqual(rows.map((row) => row.day), ["2026-10-27", "2026-10-28", "2026-10-29"]);
  assert.deepEqual(rows[0], {
    day: "2026-10-27",
    total_seconds: 20_000,
    claude_code_seconds: 5_400,
    claude_ai_seconds: 1_200,
    claude_desktop_seconds: 600,
    claude_seconds: 7_200,
    top_app: "VS Code",
    top_app_seconds: 8_000,
    uploaded: 1,
  });
  assert.deepEqual([rows[1].total_seconds, rows[1].claude_seconds, rows[1].top_app, rows[1].top_app_seconds], [0, 0, "", 0]);
  assert.deepEqual(rows.map((row) => row.uploaded), [1, 1, 1]);
});

test("a day that has not happened has no row, and a day nothing arrived on says so", () => {
  const rows = dailyRows("2026-10-29", "2026-11-01", totals, claude, apps, "Sistema", "2026-10-30", new Set(["2026-10-29"]));
  assert.deepEqual(rows.map((row) => row.day), ["2026-10-29", "2026-10-30"]);
  assert.deepEqual(rows.map((row) => row.uploaded), [1, 0]);
  assert.deepEqual(dailyRows("2026-11-01", "2026-11-02", [], [], [], "Sistema", "2026-10-30", new Set()), []);
});

test("the CSV quotes what needs it and defuses a formula in an app's name", () => {
  const csv = toCsv(dailyRows("2026-10-28", "2026-10-29", totals, claude, apps, "Sistema", "2026-10-31", new Set(["2026-10-29"])));
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "day,total_seconds,claude_code_seconds,claude_ai_seconds,claude_desktop_seconds,claude_seconds,top_app,top_app_seconds,uploaded");
  assert.equal(lines[1], "2026-10-28,0,0,0,0,0,,0,0");
  assert.equal(lines[2], "2026-10-29,3600,0,0,0,0,'=HYPERLINK(1),3600,1");
  assert.equal(lines[3], "");
  assert.equal(toCsv([{ ...dailyRows("2026-10-28", "2026-10-28", [], [], [], "S", "2026-10-31", new Set())[0], top_app: 'a, "b"' }]).split("\r\n")[1], '2026-10-28,0,0,0,0,0,"a, ""b""",0,0');
});

test("Claude's sources keep their order and the overlap note shows from two sources with time", () => {
  const names = { code: "Claude Code", web: "claude.ai", desktop: "App" };
  const sources = claudeSources({ code: 600, web: 0, desktop: 0 }, names);
  assert.deepEqual(sources.map((one) => one.key), ["code", "web", "desktop"]);
  assert.equal(sourcesOverlap(sources), false);
  assert.equal(sourcesOverlap(claudeSources({ code: 600, web: 60, desktop: 0 }, names)), true);
  assert.equal(sourcesOverlap(claudeSources(undefined, names)), false);
});

test("a week with no Claude time points to «Llaves» before the first upload, and to Hoy after it", () => {
  assert.equal(claudeWeekHint({ lastReceived: null, hasSites: false, hasClaudeCode: false }), "connect");
  assert.equal(claudeWeekHint({ lastReceived: new Date(), hasSites: false, hasClaudeCode: false }), "never");
  assert.equal(claudeWeekHint({ lastReceived: new Date(), hasSites: true, hasClaudeCode: false }), "none");
  assert.equal(claudeWeekHint({ lastReceived: new Date(), hasSites: false, hasClaudeCode: true }), "none");
});
