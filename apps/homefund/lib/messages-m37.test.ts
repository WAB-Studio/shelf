import assert from "node:assert/strict";
import { test } from "node:test";
import es from "../messages/es.json";
import en from "../messages/en.json";

test("reminderHint promises the date, not a notification", () => {
  const hint = Object.values(es).flatMap((v) =>
    typeof v === "object" && v && "reminderHint" in v ? [String((v as Record<string, unknown>).reminderHint)] : [],
  )[0];
  assert.match(hint, /aparecen en esta lista/);
  assert.doesNotMatch(hint, /avisan/);
});

test("es and en hold the same keys", () => {
  const keys = (o: unknown, p = ""): string[] =>
    o && typeof o === "object"
      ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`))
      : [p];
  assert.deepEqual(keys(es).sort(), keys(en).sort());
});

test("stale, closed-period and paused-rule refusals exist in both languages", () => {
  assert.equal(es.errors.stale, "Esto cambió mientras lo editabas. Vuelve a abrirlo.");
  assert.equal(en.errors.stale, "This changed while you were editing it. Open it again.");
  for (const m of [es, en]) {
    assert.ok(m.debts.errors.beforeReconciliation);
    assert.ok(m.recurringRules.pausedFailed);
    assert.ok(m.recurringRules.errors.nextRunOnTooEarly);
  }
});
