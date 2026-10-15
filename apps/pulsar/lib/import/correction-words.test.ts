import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { IntlMessageFormat } from "intl-messageformat";

import { cadenceWords, daysWords, rateWords } from "./correction-words";
import { normalize, type Correction, type RawDraft, type Source } from "./draft";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));
function translate(key: string, values: Record<string, string | number> = {}): string {
  const leaf = key.split(".").slice(1).reduce((node: unknown, part) => (node as Record<string, unknown> | undefined)?.[part], catalogue as unknown);
  assert.equal(typeof leaf, "string", `${key} is no message in messages/es/import.json`);
  return String(new IntlMessageFormat(leaf as string, "es").format(values));
}
const dayNames = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const correction = (said: string, values: Record<string, string>): Correction => ({ id: "x", at: "x", code: "rateToRhythm", said, proposed: "", declined: "keepsPlan", values });

// The sentences the review printed when the code built the words itself.
test("a weekly rate reads as before: «10 h por semana», «5 min por semana», «3 páginas por semana»", () => {
  assert.deepEqual(rateWords(translate, correction("10", { rateUnit: "hours", measure: "minutos" })), { rate: "10 h", said: "10 h por semana" });
  assert.equal(rateWords(translate, correction("5", { rateUnit: "minutes", measure: "minutos" })).said, "5 min por semana");
  assert.deepEqual(rateWords(translate, correction("3", { rateUnit: "units", measure: "páginas" })), { rate: "3 páginas", said: "3 páginas por semana" });
});

test("a draft saved with the Spanish text still reads as it was", () => {
  assert.deepEqual(rateWords(translate, correction("10 h por semana", {})), { rate: "10 h por semana", said: "10 h por semana" });
});

test("a cadence reads as before, one per kind", () => {
  const said = (kind: string, n: string) => cadenceWords(translate, { values: { kind, n } });
  assert.equal(said("times_per_week", "3"), "3 por semana");
  assert.equal(said("times_per_month", "4"), "4 al mes");
  assert.equal(said("every_n_days", "2"), "cada 2 días");
  assert.equal(said("daily", ""), "cada día");
  assert.equal(cadenceWords(translate, { values: { kind: "times_per_week", n: "" } }), "1 por semana");
});

test("the days read Monday first, joined by commas", () => {
  assert.equal(daysWords(translate, "1,3,7", dayNames), "lun, mié, dom");
  assert.equal(daysWords(translate, "2", dayNames), "mar");
  assert.equal(daysWords(translate, "lun, mié", dayNames), "lun, mié");
});

test("normalize stores the cadence and the days as codes the words read back", () => {
  const raw = {
    goals: [{ key: "a", name: "Meta", parent: null, horizon: null, measure: null, rate: null, months: [], rules: [], tasks: [], note: null, src: [], commitments: [
      { name: "x", satisfaction: "tap", cadenceKind: "times_per_week", cadenceN: 3, cadenceWeekdays: [7, 1, 3], targetQuantity: null, unit: null, src: [] },
    ] }],
  } as unknown as RawDraft;
  const { corrections } = normalize(raw, { kind: "parts", lines: null } as unknown as Source);
  const c = corrections.find((x) => x.code === "cadenceToWeekdays")!;
  assert.equal(cadenceWords(translate, c), "3 por semana");
  assert.equal(daysWords(translate, c.proposed, dayNames), "lun, mié, dom");
});

test("days outside Monday to Sunday are not days: 0 is printed as it came", () => {
  assert.equal(daysWords(translate, "0,1", dayNames), "0,1");
});
