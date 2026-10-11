import assert from "node:assert/strict";
import test from "node:test";

import { dayPhrase, endedPhrase } from "./day-phrase";

const TODAY = "2026-09-30"; // Wednesday; week 2026-09-28 .. 2026-10-04
const names = {
  weekdays: ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
  months: [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ],
};

// A catalogue in miniature: the near key drops the month, the far one names it.
const catalogue: Record<string, string> = {
  "day.oneOffs.carriedFrom": "del {weekday} {day}",
  "day.oneOffs.carriedFromFar": "del {weekday} {day} de {month}",
  "day.past.startedOn": "{goal} empezó el {weekday} {day}",
  "day.ended.yesterday": "{goal} terminó ayer",
  "day.ended.on": "{goal} terminó el {weekday} {day}",
  "day.ended.onFar": "{goal} terminó el {weekday} {day} de {month}",
  "day.past.startedOnFar": "{goal} empezó el {weekday} {day} de {month}",
};
function translate(key: string, values: Record<string, string | number>): string {
  return catalogue[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

test("carriedFrom inside this week drops the month, before it names it", () => {
  assert.equal(dayPhrase(translate, "day.oneOffs.carriedFrom", "2026-09-28", TODAY, names), "del lunes 28");
  assert.equal(
    dayPhrase(translate, "day.oneOffs.carriedFrom", "2026-09-27", TODAY, names),
    "del domingo 27 de septiembre",
  );
});

test("startedOn inside this week drops the month, after it names it, the goal as written", () => {
  const extra = { goal: "Inglés Crítico" };
  assert.equal(
    dayPhrase(translate, "day.past.startedOn", "2026-10-04", TODAY, names, extra),
    "Inglés Crítico empezó el domingo 4",
  );
  assert.equal(
    dayPhrase(translate, "day.past.startedOn", "2026-10-05", TODAY, names, extra),
    "Inglés Crítico empezó el lunes 5 de octubre",
  );
});

test("endedPhrase: yesterday is «ayer», two days back names the day, a far date names the month", () => {
  assert.equal(endedPhrase(translate, "Azúcar", "2026-09-29", TODAY, names), "Azúcar terminó ayer");
  assert.equal(endedPhrase(translate, "Azúcar", "2026-09-28", TODAY, names), "Azúcar terminó el lunes 28");
  assert.equal(
    endedPhrase(translate, "Azúcar", "2026-09-27", TODAY, names),
    "Azúcar terminó el domingo 27 de septiembre",
  );
});
