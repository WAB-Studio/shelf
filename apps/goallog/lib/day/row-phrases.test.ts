import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { weekdaysSentence, cadencePhrase, flexibleWords, metPhrase, phaseLine, partialPair, phasePositions, rowMeta, type RowMetaPart } from "./row-phrases";

const names = {
  weekdayName: ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
  weekdayPlural: ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"],
};
const catalogue: Record<string, string> = {
  "day.cadence.everyDay": "todos los días",
  "day.cadence.onlyWeekday": "solo los {weekday}",
  "day.cadence.timesPerWeek": "{count} veces por semana",
  "day.cadence.timesPerMonth": "{count} veces al mes",
  "day.cadence.everyNDays": "cada {n} días",
  "day.phase.of": "fase {ordinal} de {total} · {name}",
};
function translate(key: string, values: Record<string, string | number> = {}): string {
  return catalogue[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

test("a daily cadence reads «todos los días»; every 1 day says nothing", () => {
  assert.equal(cadencePhrase(translate, { kind: "daily" }, names), "todos los días");
  assert.equal(cadencePhrase(translate, { kind: "every_n_days", n: 1, anchor: "2026-09-01" }, names), null);
});

test("one weekday reads «solo los martes», several read their letters", () => {
  assert.equal(cadencePhrase(translate, { kind: "weekdays", days: [2] }, names), "solo los martes");
  assert.equal(cadencePhrase(translate, { kind: "weekdays", days: [6] }, names), "solo los sábados");
});

// The joiner of the days is the catalogue's own word, never a literal in code: the test reads the real
// messages/es/day.json, so it follows whatever key the catalogue gives it.
const dayMessages = JSON.parse(readFileSync(new URL("../../messages/es/day.json", import.meta.url), "utf8"));
function realTranslate(key: string, values: Record<string, string | number> = {}): string {
  const leaf = key.replace(/^day\./, "").split(".").reduce((node: unknown, part) => (node as Record<string, unknown> | undefined)?.[part], dayMessages as unknown);
  assert.equal(typeof leaf, "string", `${key} is no message in messages/es/day.json`);
  return (leaf as string).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}
const days = (list: number[]) => cadencePhrase(realTranslate, { kind: "weekdays", days: list }, names);

test("two days read in three letters joined by «y»", () => {
  assert.equal(days([2, 4]), "mar y jue");
  assert.equal(days([1, 4]), "lun y jue");
});

test("three or more days read as a sentence: commas, then «y» before the last", () => {
  assert.equal(days([1, 3, 5]), "lun, mié y vie");
  assert.equal(days([1, 2, 3, 4]), "lun, mar, mié y jue");
});

test("seven weekdays read «todos los días»", () => {
  assert.equal(days([1, 2, 3, 4, 5, 6, 7]), "todos los días");
});

test("six weekdays read as a list, never «todos los días»", () => {
  assert.equal(days([1, 2, 3, 4, 5, 6]), "lun, mar, mié, jue, vie y sáb");
  assert.equal(days([6, 2, 5, 1, 4, 3]), "lun, mar, mié, jue, vie y sáb");
  assert.equal(days([7, 6, 5, 4, 3, 2]), "mar, mié, jue, vie, sáb y dom");
});

test("a weekly, monthly and every-n-days cadence name their count", () => {
  assert.equal(cadencePhrase(translate, { kind: "times_per_week", count: 3 }, names), "3 veces por semana");
  assert.equal(cadencePhrase(translate, { kind: "times_per_month", count: 4 }, names), "4 veces al mes");
  assert.equal(cadencePhrase(translate, { kind: "every_n_days", n: 3, anchor: "2026-09-01" }, names), "cada 3 días");
});

test("phasePositions orders each goal's phases by start, apart from other goals", () => {
  const positions = phasePositions([
    { id: "b", goalId: "g1", startsOn: "2026-10-01" },
    { id: "a", goalId: "g1", startsOn: "2026-09-01" },
    { id: "c", goalId: "g1", startsOn: "2026-11-01" },
    { id: "x", goalId: "g2", startsOn: "2026-09-15" },
  ]);
  assert.deepEqual(positions.a, { ordinal: 1, total: 3 });
  assert.deepEqual(positions.b, { ordinal: 2, total: 3 });
  assert.deepEqual(positions.c, { ordinal: 3, total: 3 });
  assert.deepEqual(positions.x, { ordinal: 1, total: 1 });
});

test("phaseLine counts phases when there are several and names alone when there is one", () => {
  assert.equal(phaseLine(translate, "desbloquear la boca", { ordinal: 1, total: 3 }), "fase 1 de 3 · desbloquear la boca");
  assert.equal(phaseLine(translate, "desbloquear la boca", { ordinal: 1, total: 1 }), "desbloquear la boca");
});

test("metPhrase: a met flexible says its count, and its times once past the quota", () => {
  const say = (key: string, values?: Record<string, string | number>) => `${key}:${values?.done}/${values?.total}`;
  const week = { kind: "times_per_week", count: 1 } as const;
  assert.equal(metPhrase(say, { cadence: week, periodDone: 1 }), "day.met.week:1/1");
  assert.equal(metPhrase(say, { cadence: week, periodDone: 2 }), "day.met.weekOver:2/1");
  assert.equal(metPhrase(say, { cadence: week, periodDone: 0 }), null);
  assert.equal(metPhrase(say, { cadence: week, periodDone: undefined }), null);
  assert.equal(metPhrase(say, { cadence: { kind: "times_per_month", count: 2 }, periodDone: 2 }), "day.met.month:2/2");
  assert.equal(metPhrase(say, { cadence: { kind: "daily" }, periodDone: 5 }), null);
});

test("phaseLine counts a goal with exactly two phases", () => {
  assert.equal(phaseLine(translate, "empujar", { ordinal: 1, total: 2 }), "fase 1 de 2 · empujar");
  assert.equal(phaseLine(translate, "empujar", { ordinal: 2, total: 2 }), "fase 2 de 2 · empujar");
});

test("flexibleWords: weekly speaks of the week, monthly of the month, an unknown count reads 0", () => {
  const flexible = {
    "week.flexible.week": "{count} veces por semana",
    "week.flexible.month": "{count} al mes",
    "week.flexible.weekProgress": "{done} de {total} esta semana",
    "week.flexible.monthProgress": "{done} de {total} este mes",
  } as Record<string, string>;
  const say = (key: string, values: Record<string, string | number> = {}) =>
    flexible[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));

  assert.deepEqual(flexibleWords({ cadence: { kind: "times_per_week", count: 3 }, periodDone: 1 }, say), {
    cadence: "3 veces por semana",
    progress: "1 de 3 esta semana",
  });
  assert.deepEqual(flexibleWords({ cadence: { kind: "times_per_month", count: 4 }, periodDone: 3 }, say), {
    cadence: "4 al mes",
    progress: "3 de 4 este mes",
  });
  assert.equal(
    flexibleWords({ cadence: { kind: "times_per_week", count: 3 }, periodDone: null }, say)?.progress,
    "0 de 3 esta semana",
  );
  assert.equal(
    flexibleWords({ cadence: { kind: "times_per_month", count: 4 }, periodDone: null }, say)?.progress,
    "0 de 4 este mes",
  );
  assert.equal(flexibleWords({ cadence: { kind: "daily" }, periodDone: null }, say), null);
});

const rowCatalogue: Record<string, string> = {
  "day.row.saidByYou": "lo dijiste tú",
  "day.row.asksNumber": "pide el número",
  "day.row.partialAmount": "{logged} de {target}",
};
const rowTranslate = (key: string, values: Record<string, string | number> = {}) =>
  rowCatalogue[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
const line = (parts: RowMetaPart[] | undefined) => parts?.map((part) => ("figure" in part ? part.figure : part.text)).join("");
const figures = (parts: RowMetaPart[] | undefined) => parts?.flatMap((part) => ("figure" in part ? [part.figure] : []));
const base = {
  kind: "tap" as const,
  done: false,
  quiet: false,
  cadenceText: null,
  amount: "10 min",
  status: null,
  writtenTime: undefined,
  writtenLabel: undefined,
};

test("a done tap or quantity row says neither its hour nor «lo dijiste tú»", () => {
  assert.equal(line(rowMeta(rowTranslate, { ...base, done: true, writtenTime: "07:40" })), "10 min");
  assert.equal(
    line(rowMeta(rowTranslate, { ...base, kind: "quantity", done: true, amount: "25 minutos", writtenTime: "07:40", writtenLabel: "anotado el lunes 21" })),
    "25 minutos · anotado el lunes 21",
  );
});

test("an unmarked quantity row never says «pide el número»: its target, then progress", () => {
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "quantity", amount: "3 min" })), "3 min");
  assert.equal(
    line(rowMeta(rowTranslate, { ...base, kind: "quantity", amount: "3 min", status: "0 de 3 esta semana" })),
    "3 min · 0 de 3 esta semana",
  );
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "quantity", cadenceText: "mar y jue", amount: "2 h" })), "mar y jue · 2 h");
});

test("an unmarked tap row says neither", () => {
  assert.equal(line(rowMeta(rowTranslate, base)), "10 min");
});

test("an evidence row never draws the hour, done or not", () => {
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "evidence", amount: "Anki", done: true, writtenTime: "07:40" })), "Anki");
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "evidence", amount: "Anki" })), "Anki");
});

const evidenceRow = { ...base, kind: "evidence" as const, cadenceText: "3 veces por semana", amount: "Anki" };

test("an unmet evidence row says what it asks, before", () => {
  const meta = line(rowMeta(rowTranslate, { ...evidenceRow, evidence: { asks: "1 búsqueda", got: null, source: "diccionario" } }));
  assert.equal(meta, "1 búsqueda");
});

test("a met evidence row says what it got, then its source", () => {
  const meta = line(rowMeta(rowTranslate, { ...evidenceRow, done: true, evidence: { asks: "1 búsqueda", got: "3 búsquedas", source: "diccionario" } }));
  assert.equal(meta, "3 búsquedas · diccionario");
  assert.equal(line(rowMeta(rowTranslate, { ...evidenceRow, done: true, evidence: { asks: "1 búsqueda", got: "3 búsquedas", source: null } })), "3 búsquedas");
});

test("an evidence row never shows its source before it is met", () => {
  const meta = line(rowMeta(rowTranslate, { ...evidenceRow, evidence: { asks: "1 búsqueda", got: null, source: "diccionario" } }));
  assert.ok(!meta?.includes("diccionario"));
});

test("a quiet row says neither", () => {
  assert.equal(line(rowMeta(rowTranslate, { ...base, quiet: true, done: true, status: "cumplida esta semana · 1 de 1" })), "10 min · cumplida esta semana · 1 de 1");
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "quantity", quiet: true })), "10 min");
});

const partial = { logged: "1 min", target: "3 min" };

test("a quantity row logged under its target reads what it holds and no hour", () => {
  const row = { ...base, kind: "quantity" as const, amount: "3 min", writtenTime: "09:22", partial };
  assert.equal(line(rowMeta(rowTranslate, row)), "1 min de 3 min");
  assert.equal(
    line(rowMeta(rowTranslate, { ...row, writtenLabel: "anotado el lunes 21" })),
    "1 min de 3 min · anotado el lunes 21",
  );
});

test("a partial row never asks for the number again", () => {
  const meta = line(rowMeta(rowTranslate, { ...base, kind: "quantity", amount: "3 min", writtenTime: "09:22", partial }));
  assert.equal(meta?.includes("pide el número"), false);
});

test("a partial quiet or evidence row keeps its own line", () => {
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "quantity", quiet: true, partial })), "10 min");
  assert.equal(line(rowMeta(rowTranslate, { ...base, kind: "evidence", amount: "Anki", partial })), "Anki");
});

test("a partial row sets only its figures apart: the words stay text", () => {
  const row = { ...base, kind: "quantity" as const, amount: "10 min", writtenTime: "17:15", partial: { logged: "5", target: "10 min" } };
  const parts = rowMeta(rowTranslate, row);
  assert.deepEqual(figures(parts), ["5", "10 min"]);
  assert.equal(line(parts), "5 de 10 min");
  assert.deepEqual(parts?.filter((part) => "text" in part).map((part) => (part as { text: string }).text), [
    " de ",
  ]);
});

test("an unmarked quantity row draws its target as a figure", () => {
  const parts = rowMeta(rowTranslate, { ...base, kind: "quantity", amount: "3 min" });
  assert.deepEqual(figures(parts), ["3 min"]);
});

test("an evidence source and a status are text, never a figure", () => {
  assert.deepEqual(figures(rowMeta(rowTranslate, { ...base, kind: "evidence", amount: "Anki", status: "1 de 3 esta semana" })), []);
});

test("a partial in kilometres says the unit once; a time pair is as it was", () => {
  assert.deepEqual(partialPair("7 kilómetros", "90 kilómetros", "kilómetros"), { logged: "7", target: "90 kilómetros" });
  assert.deepEqual(partialPair("1 kilómetro", "90 kilómetros", "kilómetros"), { logged: "1", target: "90 kilómetros" });
  assert.deepEqual(partialPair("5 min", "10 min", "min"), { logged: "5", target: "10 min" });
  assert.deepEqual(partialPair("1 h 05 min", "2 h", "min"), { logged: "1 h 05 min", target: "2 h" });
});

test("days stored out of order read Monday first", () => {
  assert.equal(days([6, 1]), "lun y sáb");
  assert.equal(days([7, 3, 1]), "lun, mié y dom");
});

const fullNames = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

test("weekdaysSentence sorts Monday first and joins with commas and «y»", () => {
  assert.equal(weekdaysSentence(realTranslate, [7, 3, 1], fullNames), "lunes, miércoles y domingo");
  assert.equal(weekdaysSentence(realTranslate, [6, 2], fullNames), "martes y sábado");
  assert.equal(weekdaysSentence(realTranslate, [4], fullNames), "jueves");
});

test("weekdaysSentence leaves its input untouched", () => {
  const stored = [7, 3, 1];
  weekdaysSentence(realTranslate, stored, fullNames);
  assert.deepEqual(stored, [7, 3, 1]);
});
