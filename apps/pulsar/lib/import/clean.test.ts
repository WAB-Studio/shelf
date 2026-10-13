import assert from "node:assert/strict";
import test from "node:test";

import { cleanLine, doneMark, taskFromLine } from "./clean";

test("a list mark, a checkbox and bold leave the text alone", () => {
  assert.equal(cleanLine("- [ ] **10 h semanales:** 5 de caso"), "10 h semanales: 5 de caso");
  assert.equal(cleanLine("  - [x] Hecho"), "Hecho");
  assert.equal(cleanLine("* una cosa"), "una cosa");
  assert.equal(cleanLine("3. tercera"), "tercera");
  assert.equal(cleanLine("2) segunda"), "segunda");
});

test("a heading, __ and backticks go", () => {
  assert.equal(cleanLine("# Reglas del plan"), "Reglas del plan");
  assert.equal(cleanLine("### Un caso `no` se __publica__"), "Un caso no se publica");
});

test("a plain line and a snake_case word stay as written", () => {
  assert.equal(cleanLine("Sin empleo antes de abril."), "Sin empleo antes de abril.");
  assert.equal(cleanLine("usar snake_case aquí"), "usar snake_case aquí");
});

test("a checked box is done today; HECHO without a date is done today", () => {
  assert.deepEqual(doneMark("- [x] Leer", "2026-10-12"), { on: "2026-10-12" });
  assert.deepEqual(doneMark("- [X] Leer", "2026-10-12"), { on: "2026-10-12" });
  assert.deepEqual(doneMark("Leer HECHO", "2026-10-12"), { on: "2026-10-12" });
  assert.equal(doneMark("- [ ] Leer", "2026-10-12"), null);
  assert.equal(doneMark("un hecho cierto", "2026-10-12"), null);
});

test("HECHO el <fecha> reads Spanish dates, abbreviated, long or ISO", () => {
  assert.deepEqual(doneMark("x ✅ HECHO el 9 oct 2026", "2026-10-12"), { on: "2026-10-09" });
  assert.deepEqual(doneMark("x HECHO el 3 de septiembre de 2026", "2026-10-12"), { on: "2026-09-03" });
  assert.deepEqual(doneMark("x HECHO el 2026-08-01", "2026-10-12"), { on: "2026-08-01" });
});

test("a date with no year takes this year, and one after today is today", () => {
  assert.deepEqual(doneMark("x HECHO el 9 oct", "2026-10-12"), { on: "2026-10-09" });
  assert.deepEqual(doneMark("x HECHO el 20 dic 2026", "2026-10-12"), { on: "2026-10-12" });
  assert.deepEqual(doneMark("x HECHO el 31 feb 2026", "2026-10-12"), { on: "2026-10-12" });
});

test("the task of the board's line: a name, 60 minutes, done on its day", () => {
  const task = taskFromLine("- [ ] **1 h · EF SET (línea base de inglés).** ✅ HECHO el 9 oct 2026", "2026-10-12");
  assert.deepEqual(task, { name: "EF SET · línea base de inglés", minutes: 60, doneOn: "2026-10-09", note: null });
});

test("hours and minutes add up; a bare minutes line is a duration", () => {
  assert.equal(taskFromLine("- [ ] 2 h 30 min · Medir a 5 usuarios", "2026-10-12")?.minutes, 150);
  assert.equal(taskFromLine("30 min Leer el capítulo", "2026-10-12")?.minutes, 30);
  assert.equal(taskFromLine("1,5 h · Dibujar", "2026-10-12")?.minutes, 90);
});

test("a checkbox line with no duration is a task with no estimate", () => {
  assert.deepEqual(taskFromLine("- [ ] Llamar al banco", "2026-10-12"), { name: "Llamar al banco", minutes: null, doneOn: null, note: null });
});

test("a line that is neither a checkbox nor starts with a duration is no task", () => {
  assert.equal(taskFromLine("Sin empleo antes de abril.", "2026-10-12"), null);
  assert.equal(taskFromLine("## Un caso no se publica", "2026-10-12"), null);
  assert.equal(taskFromLine("", "2026-10-12"), null);
});

test("a rate is not a duration: «10 h semanales» is no task by its hours", () => {
  assert.equal(taskFromLine("10 h semanales: 5 de caso, 3 de inglés", "2026-10-12"), null);
});

test("903d: a rate line is no task even with a box or a done mark", () => {
  for (const line of ["- [ ] 10 h semanales: 5 de caso", "- [x] 10 h semanales: 5", "- [ ] 2 h al mes: x", "- [ ] 30 min por día", "- [ ] 3 h a la semana", "- [ ] 1 h diarios", "10 h semanales HECHO"]) {
    assert.equal(taskFromLine(line, "2026-10-12"), null, line);
  }
});

test("HECHO alone makes a plain line a done task", () => {
  assert.deepEqual(taskFromLine("Publicar el caso 1 HECHO el 9 oct 2026", "2026-10-12"), {
    name: "Publicar el caso 1",
    minutes: null,
    doneOn: "2026-10-09",
    note: null,
  });
});

test("a name past 120 characters is cut on a word and the whole line goes to its note", () => {
  const long = `- [ ] ${"palabra ".repeat(25).trim()}`;
  const task = taskFromLine(long, "2026-10-12");
  assert.ok(task);
  assert.ok(task.name.length <= 120);
  assert.equal(task.note, "palabra ".repeat(25).trim());
});
