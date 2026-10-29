import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_DAYS, uploadSchema } from "./upload";
import { addDays } from "./zone";

const today = "2026-10-28";
const parse = (body: unknown) => uploadSchema(today).safeParse(body);
const day = (on: string, apps: { app: string; seconds: number }[] = [{ app: "Code.exe", seconds: 3600 }]) => ({ day: on, apps });

test("an upload of app seconds per day passes, trimmed", () => {
  const result = parse({ device: " PC-WILSON ", days: [day(today, [{ app: " chrome.exe ", seconds: 60 }])] });
  assert.ok(result.success);
  assert.equal(result.data.device, "PC-WILSON");
  assert.equal(result.data.days[0].apps[0].app, "chrome.exe");
});

test("a day with no apps passes: it empties that day (RT-02)", () => {
  assert.ok(parse({ device: "pc", days: [day(today, [])] }).success);
});

test("a window title or any other field is refused (RT-01)", () => {
  assert.equal(parse({ device: "pc", days: [day(today)], titles: ["secreto"] }).success, false);
  assert.equal(parse({ device: "pc", days: [{ ...day(today), title: "x" }] }).success, true, "a day's extra key is stripped, never stored");
});

test("seconds are whole, positive and at most a day", () => {
  for (const seconds of [0, -1, 1.5, 86_401]) {
    assert.equal(parse({ device: "pc", days: [day(today, [{ app: "a", seconds }])] }).success, false, String(seconds));
  }
});

test("a day's apps add up to a day at most, and no app twice", () => {
  assert.equal(parse({ device: "pc", days: [day(today, [{ app: "a", seconds: 50_000 }, { app: "b", seconds: 40_000 }])] }).success, false);
  assert.equal(parse({ device: "pc", days: [day(today, [{ app: "a", seconds: 1 }, { app: "a", seconds: 2 }])] }).success, false);
});

test("a day must be real, not twice, and not after tomorrow", () => {
  assert.equal(parse({ device: "pc", days: [day("2026-02-30")] }).success, false);
  assert.equal(parse({ device: "pc", days: [day(today), day(today)] }).success, false);
  assert.ok(parse({ device: "pc", days: [day("2026-10-29")] }).success, "a PC ahead of Bogotá");
  assert.equal(parse({ device: "pc", days: [day("2026-10-30")] }).success, false);
});

test("between one and MAX_DAYS days", () => {
  const days = (count: number) => Array.from({ length: count }, (_, index) => day(addDays(today, -index)));
  assert.equal(parse({ device: "pc", days: [] }).success, false);
  assert.ok(parse({ device: "pc", days: days(MAX_DAYS) }).success);
  assert.equal(parse({ device: "pc", days: days(MAX_DAYS + 1) }).success, false);
});

test("a name with a control character is refused before Postgres sees it", () => {
  const upload = { device: "PC", days: [{ day: "2026-10-28", apps: [{ app: "a\u0000b", seconds: 60 }] }] };
  assert.equal(uploadSchema("2026-10-28").safeParse(upload).success, false);
});
