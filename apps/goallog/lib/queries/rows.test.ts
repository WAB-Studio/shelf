import assert from "node:assert/strict";
import test from "node:test";

import { countsInMeasure } from "@/lib/day/measure-inputs";
import type { DeclaredFact } from "@/lib/day/types";
import { reachedByMonth } from "@/lib/plan/months";

const row = { day: "2026-11-02", written_at: "2026-11-02T10:00:00Z", note: null, unit: "minutos" };

test("countsInMeasure: a commitment's fact and a confirmed allocation count, a task's own fact does not (RP-151)", () => {
  assert.equal(countsInMeasure({ commitment_id: "c1" }), true);
  assert.equal(countsInMeasure({ commitment_id: null, time_allocation: true }), true);
  assert.equal(countsInMeasure({ commitment_id: null }), false);
  assert.equal(countsInMeasure({ commitment_id: null, time_allocation: false }), false);
});

test("the month reaches a commitment's minutes plus the goal's confirmed time and nothing from a task's fact (RP-151)", () => {
  const rows = [
    { commitment_id: "c1", quantity: 30 },
    { commitment_id: null, quantity: 120, time_allocation: true },
    { commitment_id: null, quantity: 60 },
  ];
  const facts: DeclaredFact[] = rows.filter(countsInMeasure).map((r) => ({
    commitmentId: r.commitment_id ?? "",
    day: row.day,
    writtenAt: row.written_at,
    quantity: r.quantity,
    unit: row.unit,
    note: row.note,
    dayTarget: null,
  }));
  assert.equal(reachedByMonth({ unit: "minutos", facts, evidence: [] }).get("2026-11-01"), 150);
});
