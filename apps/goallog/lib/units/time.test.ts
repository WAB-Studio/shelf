import assert from "node:assert/strict";
import test from "node:test";

import { formatQuantity, formatTime, isHourUnit, isTimeUnit, minutesFromFields, parseTime, splitMinutes, storedMeasure } from "./time";

const words = {
  h: (h: string) => `${h} h`,
  min: (min: string) => `${min} min`,
  join: (h: string, min: string) => `${h} ${min}`,
};

test("the four words for a minute are time, trimmed and in any case", () => {
  for (const u of ["minutos", "minuto", "min", "mins", " Min ", "MINUTOS"]) {
    assert.equal(isTimeUnit(u), true, u);
  }
});

test("any other word, and null, is not time", () => {
  for (const u of ["horas", "páginas", "búsquedas", "", "m"]) {
    assert.equal(isTimeUnit(u), false, u);
  }
  assert.equal(isTimeUnit(null), false);
});

test("minutes split into whole hours and the rest", () => {
  assert.deepEqual(splitMinutes(90), { h: 1, min: 30 });
  assert.deepEqual(splitMinutes(59), { h: 0, min: 59 });
});

test("minutes print as the words say", () => {
  const cases: [number, string][] = [
    [0, "0 min"],
    [45, "45 min"],
    [60, "1 h"],
    [90, "1 h 30 min"],
    [720, "12 h"],
    [750, "12 h 30 min"],
    [65, "1 h 05 min"],
    [125, "2 h 05 min"],
    [5, "5 min"],
    [120, "2 h"],
    [74040, "1.234 h"],
  ];
  for (const [n, out] of cases) assert.equal(formatTime(n, words), out, String(n));
});

test("hours are floored, never a decimal", () => {
  assert.equal(formatTime(90, words), "1 h 30 min");
});

test("a quantity in a time unit prints in hours, any other as today", () => {
  assert.equal(formatQuantity(750, "minutos", words), "12 h 30 min");
  assert.equal(formatQuantity(12, "páginas", words), "12 páginas");
  assert.equal(formatQuantity(1234, "páginas", words), "1.234 páginas");
});

test("a text of hours and minutes reads back into minutes", () => {
  const cases: [string, number][] = [
    ["12 h", 720],
    ["1,5 h", 90],
    ["1.5 h", 90],
    ["1,25 h", 75],
    ["12 h 30 min", 750],
    ["90 min", 90],
    ["2h", 120],
    ["0 h", 0],
  ];
  for (const [text, n] of cases) assert.equal(parseTime(text), n, text);
});

test("a fraction that is not whole minutes, and anything else, is null", () => {
  for (const t of ["1,33 h", "hola", "", "12", "h", "1,5 h 30 min", "-2 h"]) {
    assert.equal(parseTime(t), null, t);
  }
});

test("a quantity's unit word is the one the caller agrees with the number", () => {
  const agreeing = { ...words, unit: (unit: string, n: number) => (unit === "lecciones" && n === 1 ? "lección" : unit) };
  assert.equal(formatQuantity(1, "lecciones", agreeing), "1 lección");
  assert.equal(formatQuantity(2, "lecciones", agreeing), "2 lecciones");
});

test("hours are stored as minutes, times sixty", () => {
  assert.deepEqual(storedMeasure("horas", 2), { unit: "minutos", amount: 120 });
});

test("hora, h and any case or border space read as hours", () => {
  assert.equal(isHourUnit(" H "), true);
  assert.deepEqual(storedMeasure("Hora", 1), { unit: "minutos", amount: 60 });
  assert.deepEqual(storedMeasure(" H ", 3), { unit: "minutos", amount: 180 });
});

test("an hour word without an amount keeps the amount null", () => {
  assert.deepEqual(storedMeasure("h", null), { unit: "minutos", amount: null });
});

test("any other unit is stored as written", () => {
  assert.deepEqual(storedMeasure("km", 2), { unit: "km", amount: 2 });
  assert.deepEqual(storedMeasure("min", 45), { unit: "min", amount: 45 });
  assert.equal(isHourUnit("km"), false);
});

test("reading is untouched: an hour word is still not a stored time unit", () => {
  assert.equal(isTimeUnit("horas"), false);
  assert.equal(isTimeUnit("h"), false);
});

test("«hr» and «hrs» are hours, in any case, spaced or not", () => {
  assert.equal(parseTime("8 hrs"), 480);
  assert.equal(parseTime("8hrs"), 480);
  assert.equal(parseTime("8 HRS"), 480);
  assert.equal(parseTime("1,5 hr"), 90);
  assert.equal(parseTime("2 hrs 30 min"), 150);
});

test("«hs» is hours too, in any case, with a fraction or minutes", () => {
  assert.equal(parseTime("8 hs"), 480);
  assert.equal(parseTime("8HS"), 480);
  assert.equal(parseTime("1,5 hs"), 90);
  assert.equal(parseTime("2 hs 30 min"), 150);
});

test("nothing else after «h» is an hour word", () => {
  for (const text of ["8 hss", "8 hx", "8 hrss"]) assert.equal(parseTime(text), null, text);
});

test("hours, hour, hrs and hr are hours, and are stored as minutes", () => {
  for (const word of ["hours", "hour", "hrs", "hr", " Hours "]) {
    assert.equal(isHourUnit(word), true, word);
    assert.deepEqual(storedMeasure(word, 2), { unit: "minutos", amount: 120 }, word);
  }
});

test("minutes and minute are stored as minutos with the amount as it is, and still do not read as stored time", () => {
  assert.deepEqual(storedMeasure("minutes", 90), { unit: "minutos", amount: 90 });
  assert.deepEqual(storedMeasure("Minute", 10), { unit: "minutos", amount: 10 });
  assert.equal(isTimeUnit("minutes"), false);
  assert.deepEqual(storedMeasure("minutos", 5), { unit: "minutos", amount: 5 });
});

test("minutesFromFields: blank, one blank read as 0, whole numbers only, minutes to 59", () => {
  assert.deepEqual(minutesFromFields("", ""), { kind: "blank" });
  assert.deepEqual(minutesFromFields(" ", ""), { kind: "blank" });
  assert.deepEqual(minutesFromFields("2", ""), { kind: "minutes", minutes: 120 });
  assert.deepEqual(minutesFromFields("", "45"), { kind: "minutes", minutes: 45 });
  assert.deepEqual(minutesFromFields("1", "30"), { kind: "minutes", minutes: 90 });
  assert.deepEqual(minutesFromFields("0", "59"), { kind: "minutes", minutes: 59 });
  assert.deepEqual(minutesFromFields("0", "60"), { kind: "minutesInvalid" });
  assert.deepEqual(minutesFromFields("1,5", "0"), { kind: "hoursInvalid" });
  assert.deepEqual(minutesFromFields("-1", ""), { kind: "hoursInvalid" });
  assert.deepEqual(minutesFromFields("1", "x"), { kind: "minutesInvalid" });
  assert.deepEqual(minutesFromFields("1", "2.5"), { kind: "minutesInvalid" });
});
