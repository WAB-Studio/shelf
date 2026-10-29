import assert from "node:assert/strict";
import { test } from "node:test";

import { tools, type Reads } from "./tools";

const TODAY = "2026-10-28";

function tool(name: string) {
  const spec = tools.find((one) => one.name === name);
  assert.ok(spec);
  return spec;
}

// A fake store: the asked ranges are recorded, the rows are fixed.
function fakeReads() {
  const asked: string[] = [];
  const reads: Reads = {
    async appsBetween(from, to) {
      asked.push(`apps ${from}..${to}`);
      return [
        { app: "Code.exe", seconds: 11520 },
        { app: "chrome.exe", seconds: 40 },
      ];
    },
    async dayTotals(from, to) {
      asked.push(`days ${from}..${to}`);
      return [{ day: "2026-10-27", seconds: 11560 }];
    },
  };
  return { reads, asked };
}

test("get_day reads today when no day is given, with each time in text beside its seconds", async () => {
  const { reads, asked } = fakeReads();
  const outcome = await tool("get_day").run(reads, {}, TODAY);
  assert.deepEqual(asked, ["apps 2026-10-28..2026-10-28"]);
  assert.deepEqual(outcome, {
    ok: true,
    value: {
      day: TODAY,
      apps: [
        { app: "Code.exe", seconds: 11520, text: "3 h 12 min" },
        { app: "chrome.exe", seconds: 40, text: "< 1 min" },
      ],
      total: { seconds: 11560, text: "3 h 12 min" },
    },
  });
});

test("get_week reads Monday to Sunday and fills a day with nothing at zero", async () => {
  const { reads, asked } = fakeReads();
  const outcome = await tool("get_week").run(reads, { day: "2026-11-01" }, TODAY);
  assert.deepEqual(asked.sort(), ["apps 2026-10-26..2026-11-01", "days 2026-10-26..2026-11-01"]);
  assert.ok(outcome.ok);
  const days = outcome.value.days as { day: string; seconds: number }[];
  assert.equal(days.length, 7);
  assert.deepEqual(days.slice(0, 2).map((one) => one.seconds), [0, 11560]);
  assert.equal(outcome.value.from, "2026-10-26");
});

test("a day that is not a real date is refused before anything is read", async () => {
  const { reads, asked } = fakeReads();
  assert.deepEqual(await tool("get_day").run(reads, { day: "2026-02-30" }, TODAY), { ok: false, error: "day" });
  assert.deepEqual(await tool("get_week").run(reads, { day: 5 }, TODAY), { ok: false, error: "day" });
  assert.deepEqual(asked, []);
});

test("get_range takes up to 366 days, from on or before to", async () => {
  const { reads } = fakeReads();
  const range = tool("get_range");
  assert.ok((await range.run(reads, { from: "2026-01-01", to: "2027-01-01" }, TODAY)).ok);
  assert.deepEqual(await range.run(reads, { from: "2026-01-01", to: "2027-01-02" }, TODAY), { ok: false, error: "range" });
  assert.deepEqual(await range.run(reads, { from: "2026-10-28", to: "2026-10-27" }, TODAY), { ok: false, error: "range" });
  assert.ok((await range.run(reads, { from: TODAY, to: TODAY }, TODAY)).ok);
});
