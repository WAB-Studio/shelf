import assert from "node:assert/strict";
import test from "node:test";

import { evidenceDaysFor } from "./measure-inputs";
import type { EvidenceDay } from "./types";

const row = (day: string, quantity: number, unit: string): EvidenceDay => ({
  day,
  quantity,
  unit,
  labelKey: "sources.readingLookups",
});
const source = (key: string, unit: string) => ({ satisfaction: "evidence", source_key: key, source_unit: unit });
const bySourceKey = { reading: [row("2026-09-28", 3, "min"), row("2026-09-29", 4, "min")] };

test("evidenceDaysFor: a source in the goal's unit feeds the measure", () => {
  assert.equal(evidenceDaysFor("min", [source("reading", "min")], bySourceKey).length, 2);
});

test("evidenceDaysFor: a source in another unit feeds nothing", () => {
  assert.deepEqual(evidenceDaysFor("min", [source("reading", "words")], bySourceKey), []);
  assert.deepEqual(evidenceDaysFor(null, [source("reading", "min")], bySourceKey), []);
});

test("evidenceDaysFor: two commitments on one source key count its rows once", () => {
  const days = evidenceDaysFor("min", [source("reading", "min"), source("reading", "min")], bySourceKey);
  assert.equal(days.length, 2);
});

test("evidenceDaysFor: an unreadable source feeds nothing", () => {
  assert.deepEqual(evidenceDaysFor("min", [source("reading", "min")], {}), []);
});

test("evidenceDaysFor: a tap commitment names no source", () => {
  assert.deepEqual(
    evidenceDaysFor("min", [{ satisfaction: "tap", source_key: null, source_unit: null }], bySourceKey),
    [],
  );
});
