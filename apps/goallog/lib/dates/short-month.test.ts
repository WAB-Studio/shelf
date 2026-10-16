import assert from "node:assert/strict";
import { test } from "node:test";

import { shortMonth } from "./short-month";

const EXPECTED = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

test("every month index reads as its three letters, September as «sep»", () => {
  EXPECTED.forEach((word, index) => {
    const month = String(index + 1).padStart(2, "0");
    assert.equal(shortMonth(`2026-${month}-15`), word);
    assert.equal(shortMonth(`2026-${month}`), word);
  });
  assert.equal(shortMonth("2026-09-21"), "sep");
});
