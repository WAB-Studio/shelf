import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { draftRefusals, importDraftJsonSchema } from "./draft";
import { coverage } from "./coverage";
import { parseTemplate as parseV2, parseTemplateV1 as parseTemplate, templateSource } from "./template";
import { GOAL_NAME_MAX, GOAL_NOTE_MAX } from "@/lib/validation/plan";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));

// The first template's example, as the catalogue showed it before the second: the v1 tests read it.
const EXAMPLE = "pulsar · plantilla 1\n\n# IA aplicada\nhorizonte: 2027-10-01\nmedida: horas de estudio · minutos\nritmo: 12 h\n\n## Fases\n- 2026-10-01 a 2026-12-31 · Evals y harness\n\n## Meses\n- 2026-10 · 12 h\n- 2026-11 · 20 h\n\n## Compromisos\n- Tema técnico · martes y jueves · 2 h\n- Inglés pasivo · cada día · toque\n\n## Tareas\n- 2026-10 · 4 h · Leer AI Engineering cap. 1–4\n- 2026-10 · Tutor\n  nota: Preguntar por la tarifa por hora.\n  nota: Pedir una clase de prueba antes de pagar.\n  - 1 h · Elegir tutor\n    nota: Comparar tres perfiles.\n  - 6 h · Sesiones 1–4";

const EXAMPLE2 = `pulsar · plantilla 2

# Carrera en IA
horizonte: 2028-10-01
nota: Lo que busco en dos años.
nota: Un ritmo que pueda sostener.

# IA aplicada
horizonte: 2027-10-01
dentro de: Carrera en IA

# Evals y harness
horizonte: 2027-03-01
dentro de: IA aplicada
medida: horas de estudio · minutos
ritmo: 12 h
nota: Empezar por lo que ya sé medir.

## Fases
- 2026-10-01 a 2026-12-31 · Evals y harness

## Meses
- 2026-10 · 12 h
- 2026-11 · 20 h

## Compromisos
- Tema técnico · martes y jueves · 2 h
- Inglés pasivo · cada día · toque

## Tareas
- 2026-10 · 4 h · Leer AI Engineering cap. 1–4
- 2026-10 · Tutor
  nota: Preguntar por la tarifa por hora.
  nota: Pedir una clase de prueba antes de pagar.
  - 1 h · Elegir tutor
    nota: Comparar tres perfiles.
  - 6 h · Sesiones 1–4`;

// The v1 tests below read through the v1 projection of the v2 reader: same text, same content as before.
test("PLANTILLA.md's example is the fixture's, byte for byte", () => {
  const doc = readFileSync(new URL("../../../../docs/pulsar/PLANTILLA.md", import.meta.url), "utf8");
  const fenced = /```\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(fenced);
  assert.equal(fenced[1], EXAMPLE2);
});

test("the example reads into the draft it describes, minutes and all", () => {
  const result = parseTemplate(EXAMPLE);
  assert.ok(result.matched && "draft" in result);
  assert.deepEqual(result.draft, {
    goals: [
      {
        name: "IA aplicada",
        horizon: "2027-10-01",
        measure: { name: "horas de estudio", unit: "minutos" },
        rhythm: 720,
        phases: [{ aim: "Evals y harness", startsOn: "2026-10-01", endsOn: "2026-12-31" }],
        months: [
          { month: "2026-10", amount: 720 },
          { month: "2026-11", amount: 1200 },
        ],
        commitments: [
          { name: "Tema técnico", cadenceKind: "weekdays", cadenceWeekdays: [2, 4], cadenceN: null, satisfaction: "quantity", targetQuantity: 120, unit: "minutos" },
          { name: "Inglés pasivo", cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null, satisfaction: "tap", targetQuantity: null, unit: null },
        ],
        tasks: [
          { name: "Leer AI Engineering cap. 1–4", month: "2026-10", estimate: 240, children: [] },
          {
            name: "Tutor",
            month: "2026-10",
            estimate: null,
            note: "Preguntar por la tarifa por hora.\nPedir una clase de prueba antes de pagar.",
            children: [
              { name: "Elegir tutor", estimate: 60, note: "Comparar tres perfiles." },
              { name: "Sesiones 1–4", estimate: 360 },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(draftRefusals(result.draft, "2026-10-01"), []);
});

test("a text whose first non-empty line is not the header is not matched", () => {
  assert.deepEqual(parseTemplate(""), { matched: false });
  assert.deepEqual(parseTemplate("# IA\nhorizonte: 2027-10-01"), { matched: false });
  assert.deepEqual(parseTemplate("hola\npulsar · plantilla 1"), { matched: false });
});

test("blank lines before the header, CRLF and trailing spaces still match", () => {
  const result = parseTemplate("\n\r\npulsar · plantilla 1  \r\n# A\r\nhorizonte: 2027-10-01  \r\n");
  assert.ok(result.matched && "draft" in result);
});

// `expected` is a catalogue key, optionally prefixed with the file's namespace; the sentence is what the person reads.
function sentenceOf(key: string): string {
  let node: unknown = catalogue;
  for (const part of key.replace(/^import\./, "").split(".")) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  assert.equal(typeof node, "string", `«${key}» is not a string in messages/es/import.json`);
  assert.notEqual((node as string).trim(), "", key);
  return node as string;
}

function errorOf(text: string) {
  const result = parseTemplate(text);
  assert.ok(result.matched && "error" in result, JSON.stringify(result));
  return result.error;
}

const HEAD = "pulsar · plantilla 1\n\n# A\nhorizonte: 2027-10-01\nmedida: horas · minutos\n";

test("every cadence the commitment form words is read", () => {
  const cadences: Record<string, object> = {
    "cada día": { cadenceKind: "daily", cadenceWeekdays: null, cadenceN: null },
    "lunes y jueves": { cadenceKind: "weekdays", cadenceWeekdays: [1, 4], cadenceN: null },
    "lunes, martes y jueves": { cadenceKind: "weekdays", cadenceWeekdays: [1, 2, 4], cadenceN: null },
    "3 veces por semana": { cadenceKind: "times_per_week", cadenceWeekdays: null, cadenceN: 3 },
    "cada 2 días": { cadenceKind: "every_n_days", cadenceWeekdays: null, cadenceN: 2 },
    "2 veces al mes": { cadenceKind: "times_per_month", cadenceWeekdays: null, cadenceN: 2 },
  };
  for (const [words, expected] of Object.entries(cadences)) {
    const result = parseTemplate(`${HEAD}## Compromisos\n- x · ${words} · toque\n`);
    assert.ok(result.matched && "draft" in result, words);
    assert.deepEqual({ ...result.draft.goals[0].commitments[0] }, { name: "x", satisfaction: "tap", targetQuantity: null, unit: null, ...expected }, words);
  }
});

test("an unreadable cadence stops at its line, saying the form", () => {
  assert.equal(errorOf(`${HEAD}## Compromisos\n- x · cuando pueda · toque\n`).line, 7);
});

test("a cadence the form refuses stops at its line", () => {
  assert.equal(errorOf(`${HEAD}## Compromisos\n- x · 8 veces por semana · toque\n`).line, 7);
});

test("amounts of a time unit go through parseTime; any other unit takes whole numbers", () => {
  const time = parseTemplate(`${HEAD}## Meses\n- 2026-10 · 1,5 h\n- 2026-11 · 12 h 30 min\n- 2026-12 · 90 min\n`);
  assert.ok(time.matched && "draft" in time);
  assert.deepEqual(time.draft.goals[0].months.map((m) => m.amount), [90, 750, 90]);
  assert.equal(errorOf(`${HEAD}## Meses\n- 2026-10 · 12\n`).line, 7);

  const pages = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\nmedida: páginas · páginas\n## Meses\n- 2026-10 · 40\n";
  const parsed = parseTemplate(pages);
  assert.ok(parsed.matched && "draft" in parsed);
  assert.equal(parsed.draft.goals[0].months[0].amount, 40);
  assert.equal(errorOf(pages.replace("40", "2 h")).line, 6);
});

test("a sub-task is two spaces in under its task, and only that", () => {
  const tasks = (child: string) => `${HEAD}## Tareas\n- 2026-10 · Tutor\n${child}\n`;
  const ok = parseTemplate(tasks("  - 1 h · Elegir"));
  assert.ok(ok.matched && "draft" in ok);
  assert.deepEqual(ok.draft.goals[0].tasks[0].children, [{ name: "Elegir", estimate: 60 }]);
  for (const bad of [" - 1 h · Elegir", "   - 1 h · Elegir", "    - 1 h · Elegir", "\t- 1 h · Elegir"]) {
    assert.equal(errorOf(tasks(bad)).line, 8, JSON.stringify(bad));
  }
});

test("a sub-task with no task above it, or in another section, is refused", () => {
  assert.equal(errorOf(`${HEAD}## Tareas\n  - Elegir\n`).line, 7);
  assert.equal(errorOf(`${HEAD}## Meses\n  - 1 h\n`).line, 7);
  assert.equal(errorOf(`${HEAD}## Tareas\n- 2026-10 · A\n## Meses\n  - Elegir\n`).line, 9);
});

test("a line outside a goal names its line", () => {
  assert.equal(errorOf("pulsar · plantilla 1\n\nhola\n").line, 3);
  assert.equal(errorOf("pulsar · plantilla 1\n").line, 2);
});

test("an unknown section stops at its line", () => {
  assert.equal(errorOf(`${HEAD}## Notas\n`).line, 6);
  const result = parseTemplate(`${HEAD}## Notas\n  nota: a\n`);
  assert.ok(result.matched && "errors" in result);
  assert.deepEqual(result.errors.map((e) => e.line), [6]);
});

test("a schema refusal lands on the line that wrote it", () => {
  assert.equal(errorOf("pulsar · plantilla 1\n# A\nhorizonte: 2027-02-31\n").line, 3);
  assert.equal(errorOf(`${HEAD}## Meses\n- 2026-10 · 1 h\n- 2026-13 · 1 h\n`).line, 8);
  assert.equal(errorOf(`${HEAD}## Fases\n- 2026-12-31 a 2026-10-01 · x\n`).line, 7);
});

test("two goals read as two", () => {
  const result = parseTemplate("pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\n# B\nhorizonte: 2027-11-01\n");
  assert.ok(result.matched && "draft" in result);
  assert.deepEqual(result.draft.goals.map((g) => g.name), ["A", "B"]);
});

test("a quantity commitment on a goal with no measure is refused at its line", () => {
  const text = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\n## Compromisos\n- x · cada día · 2 h\n";
  assert.equal(errorOf(text).line, 5);
});

function draftOf(text: string) {
  const result = parseTemplate(text);
  assert.ok(result.matched && "draft" in result, JSON.stringify(result));
  return result.draft.goals[0];
}

test("a sub-task whose amount is not an amount stops at its line", () => {
  const error = errorOf(`${HEAD}## Tareas\n- 2026-10 · Tutor\n  - abc · Nombre\n`);
  assert.equal(error.line, 8);
});

test("a leading BOM still matches", () => {
  assert.equal(draftOf("﻿pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\n").name, "A");
});

test("«todos los días» reads as daily", () => {
  assert.equal(draftOf(`${HEAD}## Compromisos\n- x · todos los días · toque\n`).commitments[0].cadenceKind, "daily");
});

test("miércoles, sábados and domingos are recognised, in any order, once each", () => {
  const days = (words: string) => draftOf(`${HEAD}## Compromisos\n- x · ${words} · toque\n`).commitments[0].cadenceWeekdays;
  assert.deepEqual(days("miércoles, sábados y domingos"), [3, 6, 7]);
  assert.deepEqual(days("jueves y lunes"), [1, 4]);
  assert.deepEqual(days("lunes y lunes"), [1]);
});

test("«1 vez por semana» and «Toque» are accepted", () => {
  const c = draftOf(`${HEAD}## Compromisos\n- x · 1 vez por semana · Toque\n`).commitments[0];
  assert.equal(c.cadenceKind, "times_per_week");
  assert.equal(c.cadenceN, 1);
  assert.equal(c.satisfaction, "tap");
  assert.equal(draftOf(`${HEAD}## Compromisos\n- x · 1 vez al mes · toque\n`).commitments[0].cadenceKind, "times_per_month");
});

test("a name keeps its « · », in a task and in a sub-task", () => {
  const task = draftOf(`${HEAD}## Tareas\n- 2026-10 · 4 h · A · B\n  - 1 h · E · F\n`).tasks;
  assert.equal(task[0].name, "A · B");
  assert.equal(task[0].estimate, 240);
  assert.equal(task[0].children[0].name, "E · F");
});

test("with a non-time unit, «2 h» fails with the whole-number form", () => {
  const text = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\nmedida: páginas · páginas\n## Tareas\n- 2026-10 · 2 h · Leer\n";
  assert.equal(errorOf(text).line, 6);
});

test("a sub-task cannot follow a task across a section switch back to tasks", () => {
  assert.equal(errorOf(`${HEAD}## Tareas\n- 2026-10 · A\n## Tareas\n  - c\n`).line, 9);
});

test("a sub-task cannot follow a task across another section", () => {
  assert.equal(errorOf(`${HEAD}## Tareas\n- 2026-10 · A\n## Meses\n  - c\n`).line, 9);
});

const DOC = readFileSync(new URL("../../../../docs/pulsar/PLANTILLA.md", import.meta.url), "utf8");
const DOC_EXAMPLE = /```\n([\s\S]*?)\n```/.exec(DOC)![1];

test("PLANTILLA.md's example, read from the file, carries the task's two-line note and the sub-task's", () => {
  const result = parseTemplate(DOC_EXAMPLE);
  assert.ok(result.matched && "draft" in result, JSON.stringify(result));
  const [, tutor] = result.draft.goals[2].tasks;
  assert.equal(tutor.note, "Preguntar por la tarifa por hora.\nPedir una clase de prueba antes de pagar.");
  assert.equal(tutor.children[0].note, "Comparar tres perfiles.");
  assert.equal("note" in tutor.children[1], false);
  assert.equal("note" in result.draft.goals[2].tasks[0], false);
});

test("a note repeats its line; a bare nota: is a blank line; the whole is trimmed; all blank is no note", () => {
  const tasks = (body: string) => `${HEAD}## Tareas\n- 2026-10 · Tutor\n${body}\n`;
  const noteOf = (body: string) => {
    const result = parseTemplate(tasks(body));
    assert.ok(result.matched && "draft" in result, JSON.stringify(result));
    return result.draft.goals[0].tasks[0].note;
  };
  assert.equal(noteOf("  nota: uno\n  nota:\n  nota: dos"), "uno\n\ndos");
  assert.equal(noteOf("  nota:\n  nota:   uno  \n  nota:"), "uno");
  assert.equal(noteOf("  nota:\n  nota:"), null);
});

test("a note of 2001 characters stops the read at its first nota: line; 2000 passes", () => {
  // The two lines join with one line break: x repeated, a break, "más".
  const tasks = (x: number) => `${HEAD}## Tareas\n- 2026-10 · Tutor\n  nota: ${"x".repeat(x)}\n  nota: más\n`;
  assert.equal(errorOf(tasks(1997)).line, 8);
  const ok = parseTemplate(tasks(1996));
  assert.ok(ok.matched && "draft" in ok);
  assert.equal(ok.draft.goals[0].tasks[0].note?.length, 2000);
});

test("nota: anywhere but under a task or a sub-task stops the read as out of form", () => {
  const at = (body: string) => errorOf(`${HEAD}${body}\n`);
  assert.equal(at("## Compromisos\n- x · cada día · toque\n  nota: a").line, 8);
  assert.equal(at("## Meses\n  nota: a").line, 7);
  assert.equal(at("## Tareas\n  nota: a").line, 7);
  // A task's note comes before its sub-tasks; a four-space note needs a sub-task.
  assert.equal(at("## Tareas\n- 2026-10 · T\n  - 1 h · c\n  nota: a").line, 9);
  assert.equal(at("## Tareas\n- 2026-10 · T\n    nota: a").line, 8);
  assert.equal(at("## Tareas\n- 2026-10 · T\n   nota: a").line, 8);
  assert.equal(at("## Tareas\n- 2026-10 · T\nnota: a").line, 8);
});

test("a template with no nota: reads with no note key anywhere", () => {
  const result = parseTemplate(`${HEAD}## Tareas\n- 2026-10 · T\n  - 1 h · c\n`);
  assert.ok(result.matched && "draft" in result);
  assert.equal(JSON.stringify(result.draft).includes("note"), false);
});

const RHYTHM_HEAD = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\n";

function rhythmOf(unit: string, amount: string) {
  const result = parseTemplate(`${RHYTHM_HEAD}medida: horas · ${unit}\nritmo: ${amount}\n`);
  assert.ok(result.matched && "draft" in result, JSON.stringify(result));
  return result.draft.goals[0].rhythm;
}

test("ritmo: reads a time amount into minutes, in every format", () => {
  assert.equal(rhythmOf("minutos", "12 h"), 720);
  assert.equal(rhythmOf("minutos", "12 h 30 min"), 750);
  assert.equal(rhythmOf("min", "90 min"), 90);
});

test("836 hs: «hs» reads as hours in ritmo: and in a month", () => {
  assert.equal(rhythmOf("minutos", "8 hs"), 480);
  assert.equal(draftOf(`${HEAD}## Meses\n- 2026-12 · 12 hs\n`).months[0].amount, 720);
});

test("a template without ritmo: reads as before, rhythm null", () => {
  const result = parseTemplate(`${RHYTHM_HEAD}medida: horas · minutos\n`);
  assert.ok(result.matched && "draft" in result);
  assert.equal(result.draft.goals[0].rhythm, null);
});

test("ritmo: stops with its line and form when not under a time measure, not placed after medida:, or not an amount", () => {
  const stops = (text: string, line: number) => assert.equal(errorOf(`${RHYTHM_HEAD}${text}`).line, line, text);
  stops("ritmo: 10\n", 4);
  stops("medida: carrera · km\nritmo: 10 h\n", 5);
  stops("ritmo: 12 h\n", 4);
  stops("ritmo: 12 h\nmedida: horas · minutos\n", 4);
  stops("medida: horas · minutos\nritmo: 12\n", 5);
  stops("medida: horas · minutos\nritmo: 12 h\nritmo: 1 h\n", 6);
  stops("medida: horas · minutos\n## Meses\nritmo: 12 h\n", 6);
  stops("medida: horas · minutos\nritmo: 0 min\n", 5);
});

test("the draft the model is sent carries no rhythm", () => {
  assert.equal(JSON.stringify(importDraftJsonSchema).includes("rhythm"), false);
});

test("PLANTILLA.md's example, read from the file, carries ritmo: 12 h", () => {
  const fenced = /```\n([\s\S]*?)\n```/.exec(DOC);
  assert.ok(fenced && fenced[1].includes("\nritmo: 12 h\n"));
  const result = parseTemplate(fenced[1]);
  assert.ok(result.matched && "draft" in result);
  assert.equal(result.draft.goals[2].rhythm, 720);
});

test("a line out of form names its cause by a catalogue key, never by Spanish typed in lib/", () => {
  const key = (text: string) => {
    const { expected } = errorOf(text);
    sentenceOf(expected);
    return expected;
  };
  assert.match(key(`${HEAD}## Meses\n- 2026-13 · 20 h\n`), /^[A-Za-z0-9_.]+$/);
  // Different causes, different keys.
  assert.notEqual(key(`${HEAD}## Meses\n- 2026-13 · 20 h\n`), key(`${HEAD}## Compromisos\n- x · cuando pueda · toque\n`));
  assert.notEqual(key("pulsar · plantilla 1\n\nhola\n"), key(`${HEAD}## Meses\n- 2026-13 · 20 h\n`));
});

test("ritmo: in the wrong place or with the wrong measure says which cause, in the board's words", () => {
  const misplaced = errorOf(`${RHYTHM_HEAD}medida: horas de estudio · minutos\n\n## Meses\n- 2026-10 · 12 h\nritmo: 10 h\n`);
  assert.equal(sentenceOf(misplaced.expected), "El ritmo va justo después de «medida:», una sola vez por meta.");
  const noMeasure = errorOf(`${RHYTHM_HEAD}ritmo: 10 h\n`);
  assert.notEqual(noMeasure.expected, misplaced.expected);
  assert.match(sentenceOf(noMeasure.expected), /medida/);
  assert.doesNotMatch(sentenceOf(noMeasure.expected), /justo después/);
});

test("no sentence repeats the line the person wrote", () => {
  const written: [string, string][] = [
    [`${RHYTHM_HEAD}medida: horas · minutos\n## Meses\nritmo: 12 h\n`, "ritmo: 12 h"],
    [`${RHYTHM_HEAD}ritmo: 12 h\n`, "ritmo: 12 h"],
    [`${RHYTHM_HEAD}medida: horas · minutos\nritmo: 12 h\nritmo: 12 h\n`, "ritmo: 12 h"],
    [`${HEAD}## Meses\n- 2026-13 · 20 h\n`, "- 2026-13 · 20 h"],
    [`${HEAD}## Tareas\n- 2026-10 · Tutor\n  - abc · Nombre\n`, "- abc · Nombre"],
    ["pulsar · plantilla 1\n\n# X\nhola\n", "hola"],
    ["pulsar · plantilla 1\n# A\nhorizonte: 2027-02-31\n", "horizonte: 2027-02-31"],
  ];
  for (const [text, line] of written) {
    const sentence = sentenceOf(errorOf(text).expected);
    assert.equal(sentence.includes(line), false, `«${sentence}» repeats «${line}»`);
  }
});

test("ritmo: in its place with an amount that is not a time says the amount is the fault", () => {
  const text = `${RHYTHM_HEAD}medida: horas de estudio · minutos\nritmo: doce\n`;
  assert.equal(sentenceOf(errorOf(text).expected), "El ritmo es un monto por mes: un tiempo como «12 h», o un entero en la unidad de la medida.");
});

test("a measure in hours is stored in minutes, its amounts and rhythm in the time forms", () => {
  const text = [
    "pulsar · plantilla 1", "", "# Estudio", "horizonte: 2027-10-01", "medida: estudio · horas", "ritmo: 10 h", "",
    "## Meses", "- 2026-10 · 12 h", "", "## Tareas", "- 2026-10 · 90 min · Leer",
  ].join("\n");
  const result = parseTemplate(text);
  assert.ok(result.matched && "draft" in result);
  const [goal] = result.draft.goals;
  assert.equal(goal.measure?.unit, "minutos");
  assert.equal(goal.months[0].amount, 720);
  assert.equal(goal.rhythm, 600);
  assert.equal(goal.tasks[0].estimate, 90);
});

test("a bare integer amount under a measure in hours stops the reading", () => {
  const text = ["pulsar · plantilla 1", "# Estudio", "horizonte: 2027-10-01", "medida: estudio · horas", "## Meses", "- 2026-10 · 12"].join("\n");
  const result = parseTemplate(text);
  assert.ok(result.matched && "error" in result);
  assert.equal(result.error.line, 6);
});

test("ritmo: with no measure says the rhythm needs one, not that its amount is wrong", () => {
  const { expected } = errorOf(`${RHYTHM_HEAD}ritmo: 10 h\n`);
  assert.equal(sentenceOf(expected), "El ritmo va con una medida: ponla en «medida:» y el ritmo justo debajo.");
});

test("ritmo: outside time takes a whole number, and a time under it says the amount is the fault", () => {
  for (const unit of ["km", "páginas"]) {
    const { expected } = errorOf(`${RHYTHM_HEAD}medida: carrera · ${unit}\nritmo: 10 h\n`);
    assert.match(sentenceOf(expected), /entero/);
  }
});

const KM = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\nmedida: carrera · km\n## Meses\n";

test("a month amount takes the goal's own unit after the number, or the bare number", () => {
  for (const amount of ["8", "8 km", "8km", "8 KM"]) {
    assert.equal(draftOf(`${KM}- 2026-10 · ${amount}\n`).months[0].amount, 8, amount);
  }
  assert.equal(draftOf(`${HEAD}## Meses\n- 2026-10 · 12 h\n`).months[0].amount, 720);
});

test("a month amount in another unit than the goal's stops saying which unit to write", () => {
  const error = errorOf(`${KM}- 2026-10 · 8 h\n`);
  assert.deepEqual(error, { line: 6, expected: "import.errors.form.monthUnit", unit: "km" });
  assert.equal(errorOf(`${KM}- 2026-10 · ocho\n`).expected, "import.errors.form.month");
  assert.equal(errorOf(`${HEAD}## Meses\n- 2026-10 · 8 km\n`).expected, "import.errors.form.monthTime");
});

test("a month's amount tolerates spacing and case around the goal's unit", () => {
  for (const amount of ["8   km", "8\tkm", " 8 km", "8 Km"]) {
    assert.equal(draftOf(`${KM}- 2026-10 · ${amount}\n`).months[0].amount, 8, JSON.stringify(amount));
  }
});

test("a month with a unit and no number is the generic month error, never an amount of 0", () => {
  for (const amount of ["km", " km"]) {
    assert.equal(errorOf(`${KM}- 2026-10 · ${amount}\n`).expected, "import.errors.form.month", JSON.stringify(amount));
  }
});

test("a month's wrong unit stuck to the number says the unit, like the spaced one", () => {
  assert.deepEqual(errorOf(`${KM}- 2026-10 · 8h\n`), errorOf(`${KM}- 2026-10 · 8 h\n`));
  assert.equal(errorOf(`${KM}- 2026-10 · 8h\n`).expected, "import.errors.form.monthUnit");
});

test("a decimal month amount says amounts are whole numbers, whatever the separator or unit", () => {
  for (const amount of ["8.5 km", "8,5 km", "8.5", "8,5"]) {
    const error = errorOf(`${KM}- 2026-10 · ${amount}\n`);
    assert.deepEqual(error, { line: 6, expected: "import.errors.form.monthWhole", unit: "km" }, amount);
  }
});

// RP-72: one reading lists every line that cannot be read, in the text's order.
// `errors` is the list; each entry carries its line, a catalogue key in `expected`, and the goal's `unit` when the sentence names one.
type Mistake = { line: number; expected: string; unit?: string };
function mistakesOf(text: string): Mistake[] {
  const result = parseTemplate(text) as unknown as { matched: boolean; errors?: Mistake[] };
  assert.ok(result.matched && Array.isArray(result.errors), JSON.stringify(result));
  return result.errors;
}
const said = (m: Mistake) => sentenceOf(m.expected).replaceAll("{unit}", m.unit ?? "");

const BOARD = [
  "pulsar · plantilla 1",
  "",
  "# Correr 10K",
  "horizonte: 2026-12-17",
  "medida: distancia · km",
  "",
  "## Meses",
  "- 2026-10 · 40 km",
  "- 2026-11 · 8 h",
  "",
  "## Compromisos",
  "- Fondo · sábado · 8 km",
  "- Series · martes · 30 min",
  "",
  "## Tareas",
  "- 2026-10 · 2 h · Comprar zapatillas",
  "- 2026-11 · Inscribirme a la carrera",
];
const at = (written: string) => BOARD.indexOf(written) + 1;

test("RP-72 row 1: every unreadable line comes back at once, in the text's order, with its number and its sentence", () => {
  const found = mistakesOf(BOARD.join("\n"));
  assert.deepEqual(found.map((m) => m.line), [at("- 2026-11 · 8 h"), at("- Series · martes · 30 min"), at("- 2026-10 · 2 h · Comprar zapatillas")]);
  assert.deepEqual(found.map(said), [
    "Esa unidad no es km. Escribe el monto en km, como «- AAAA-MM · 8 km».",
    "Esa unidad no es km. Escribe la cantidad en km, como «- nombre · cadencia · 8 km».",
    "Quita la cifra de esta línea: esta meta no mide tiempo.",
  ]);
});

test("RP-72 row 1: the list keeps the text's order when a later kind of line breaks first", () => {
  const text = BOARD.join("\n").replace("- 2026-10 · 40 km", "- 2026-10 · 40 min");
  assert.deepEqual(mistakesOf(text).map((m) => m.line), [8, 9, 13, 16]);
});

test("RP-72 row 1: a plan with one broken line lists exactly that one", () => {
  const text = BOARD.join("\n").replace("- 2026-11 · 8 h", "- 2026-11 · 8 km").replace("- Series · martes · 30 min", "- Series · martes · 3 km").replace("- 2026-10 · 2 h · Comprar", "- 2026-10 · Comprar");
  assert.deepEqual(mistakesOf(text.replace("- 2026-10 · 40 km", "- 2026-10 · 40 min")).map((m) => m.line), [8]);
});

test("RP-72 row 3: in a goal measured in km, a commitment written «8 km» is accepted and keeps 8 and km", () => {
  const text = BOARD.join("\n").replace("- 2026-11 · 8 h", "- 2026-11 · 8 km").replace("- Series · martes · 30 min", "- Series · martes · 3 km").replace("- 2026-10 · 2 h · Comprar", "- 2026-10 · Comprar");
  const goal = draftOf(text);
  const fondo = goal.commitments.find((c) => c.name === "Fondo");
  assert.equal(fondo?.targetQuantity, 8);
  assert.equal(fondo?.unit, "km");
  assert.equal(fondo?.satisfaction, "quantity");
});

test("RP-72 row 4: a commitment in another unit than the km goal's gets the sentence that names km", () => {
  const text = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\nmedida: distancia · km\n## Compromisos\n- Series · martes · 30 min\n";
  const [only, ...rest] = mistakesOf(text);
  assert.equal(rest.length, 0);
  assert.equal(only.line, 6);
  assert.equal(only.unit, "km");
  assert.equal(said(only), "Esa unidad no es km. Escribe la cantidad en km, como «- nombre · cadencia · 8 km».");
});

test("RP-72 row 5: in a goal measured in time, a month or a commitment written in km names the goal's unit", () => {
  const head = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\nmedida: horas de estudio · minutos\n";
  const [month] = mistakesOf(`${head}## Meses\n- 2026-10 · 8 km\n`);
  assert.equal(month.line, 6);
  assert.equal(month.unit, "minutos");
  assert.equal(said(month), "Esa unidad no es de tiempo. Escribe el monto en horas o minutos, como «- AAAA-MM · 12 h».");
  const [commitment] = mistakesOf(`${head}## Compromisos\n- x · cada día · 8 km\n`);
  assert.equal(commitment.line, 6);
  assert.equal(commitment.unit, "minutos");
  assert.equal(said(commitment), "Esa unidad no es de tiempo. Escribe la cantidad en horas o minutos, como «- nombre · cadencia · 30 min».");
});

test("RP-72 row 6: a plan with no mistakes still reads into a draft", () => {
  const result = parseTemplate(EXAMPLE);
  assert.ok(result.matched && "draft" in result);
});

test("RP-72 row 6: a missing «# nombre» is still reported, first, with the goal sentence", () => {
  const found = mistakesOf("pulsar · plantilla 1\nhorizonte: 2027-10-01\n");
  assert.equal(found[0].line, 2);
  assert.match(said(found[0]), /^Falta el nombre de la meta/);
});

const GOAL = "pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\n";

test("RP-72 row 1: lines are listed by ascending line even when a later line is found before an earlier one", () => {
  const found = mistakesOf(`${GOAL}## Meses\n- 2020-01 · 5 h\n## Tareas\n- x\n`).map((m) => m.line);
  assert.ok(found.length >= 2, JSON.stringify(found));
  assert.deepEqual(found, [...found].sort((a, b) => a - b));
  assert.deepEqual(found, [...new Set(found)]);
});

test("RP-72 row 1: an unknown «## » section reports itself once, not the lines under it", () => {
  const found = mistakesOf(`${GOAL}## Cosas\n- uno\n- dos · tres\n  - cuatro\n`);
  assert.deepEqual(found.map((m) => m.line), [4]);
});

test("RP-72 row 1: a broken task reports itself once, not its sub-tasks nor its «nota:»", () => {
  const found = mistakesOf(`${GOAL}## Tareas\n- 2026-10 · 2 h · Rota\n  - 30 min · hija\n  - otra\n  nota: de la tarea\n    nota: de la hija\n`);
  assert.deepEqual(found.map((m) => m.line), [5]);
});

test("RP-72 row 1: a broken sub-task reports itself once, not its «nota:»", () => {
  const found = mistakesOf(`${GOAL}## Tareas\n- 2026-10 · Madre\n  - 30 min · mala hija\n    nota: de la hija rota\n`);
  assert.deepEqual(found.map((m) => m.line), [6]);
});

test("RP-72 row 1: `error` is the first of `errors`, the one a single-error reader shows", () => {
  const read = parseTemplate(`${GOAL}## Meses\n- 2020-01 · 5 h\n## Tareas\n- x\n`);
  assert.ok(read.matched && "error" in read);
  assert.ok(read.errors.length >= 2);
  assert.deepEqual(read.error, read.errors[0]);
});

// Module 801. A broken header cuts the reading (RP-72 holds only after a sound header); a wrong first line is refused here.
const HEAD_OK = "pulsar · plantilla 1\n\n# Correr 10K\nhorizonte: 2026-12-17\n";

test("801 cut: a measure without its unit answers that one line, and the broken month below is not judged", () => {
  const text = `${HEAD_OK}medida: distancia\n\n## Meses\n- 2026-11 · 8 h\n`;
  const found = mistakesOf(text);
  assert.deepEqual(found, [{ line: 5, expected: "import.errors.form.measure" }]);
  assert.equal(said(found[0]), "La medida va como «medida: nombre · unidad».");
});

test("801 cut: the header's other lines cut too — a bad horizon hides the broken lines below it", () => {
  const found = mistakesOf("pulsar · plantilla 1\n# Correr\nhorizonte: pronto\nmedida: distancia · km\n## Meses\n- 2026-11 · 8 h\n");
  assert.deepEqual(found.map((m) => m.line), [3]);
});

test("801 cut: a «ritmo:» the reader cannot take is a header error and cuts the reading", () => {
  const found = mistakesOf(`${HEAD_OK}medida: distancia · km\nritmo: 12 h\n\n## Meses\n- 2026-11 · 8 h\n`);
  assert.deepEqual(found.map((m) => m.line), [6]);
});

test("801 cut: after a sound header every broken line is still listed at once", () => {
  const found = mistakesOf(`${HEAD_OK}medida: distancia · km\n\n## Meses\n- 2026-11 · 8 h\n\n## Compromisos\n- Series · martes · 30 min\n`);
  assert.deepEqual(found.map((m) => m.line), [8, 11]);
});

test("801 first line: «pulsar ·» with another version is refused on line 1, matched, with no draft", () => {
  for (const first of ["pulsar · plantilla 3", "pulsar · plantilla 10", "pulsar · plantilla 1 bis", "pulsar · plantilla"]) {
    const found = mistakesOf(`${first}\n\n# Correr 10K\nhorizonte: 2026-12-17\nmedida: distancia · km\n`);
    assert.deepEqual(found.map((m) => m.line), [1], first);
  }
});

test("801 first line: the refusal names the first line and the header the plantilla wants", () => {
  const [only] = mistakesOf("pulsar · plantilla 3\n# A\nhorizonte: 2027-10-01\n");
  assert.equal(said(only), "La primera línea va como «pulsar · plantilla 2».");
});

test("801 first line: a text that does not start with «pulsar ·» still goes to the AI reading", () => {
  for (const text of ["pulsar plantilla 1\n# A", "mi plan\npulsar · plantilla 2", "# A\nhorizonte: 2027-10-01"]) {
    assert.deepEqual(parseTemplate(text), { matched: false }, text);
  }
});

test("801 cut: several broken head lines answer the first one only", () => {
  const found = mistakesOf("pulsar · plantilla 1\n# A\nhorizonte: pronto\n# B\nhorizonte: nunca\n");
  assert.deepEqual(found.map((m) => m.line), [3]);
});

// Module 801, mutation killers. A schema refusal on a head field is a head error: it cuts, and the broken month below is not judged.
const BROKEN_MONTH = "## Meses\n- 2026-11x · 8 h\n";

function cutOf(text: string) {
  const result = parseTemplate(text);
  assert.ok(result.matched && "errors" in result, JSON.stringify(result));
  return result;
}

test("801 cut: a goal name over the limit is one error on its line, and cuts", () => {
  const result = cutOf(`${"pulsar · plantilla 1\n"}# ${"a".repeat(300)}\nhorizonte: 2026-12-17\nmedida: d · km\n${BROKEN_MONTH}`);
  assert.deepEqual(result.errors.map((e) => e.line), [2]);
  assert.equal(result.cut, true);
});

test("801 cut: a unit over 40 characters and a measure name over the limit are one error on the measure line, and cut", () => {
  for (const measure of [`d · ${"k".repeat(60)}`, `${"d".repeat(300)} · km`]) {
    const result = cutOf(`pulsar · plantilla 1\n# A\nhorizonte: 2026-12-17\nmedida: ${measure}\n${BROKEN_MONTH}`);
    assert.deepEqual(result.errors.map((e) => e.line), [4], measure.slice(0, 12));
    assert.equal(result.cut, true);
  }
});

test("801 cut: a rhythm the schema refuses is one error on its line, and cuts", () => {
  const result = cutOf(`pulsar · plantilla 1\n# A\nhorizonte: 2026-12-17\nmedida: d · minutos\nritmo: 99999 h\n${BROKEN_MONTH}`);
  assert.deepEqual(result.errors.map((e) => e.line), [5]);
  assert.equal(result.cut, true);
});

test("801 first line: «pulsar ·» in the middle of the first line still goes to the AI reading", () => {
  assert.deepEqual(parseTemplate("mi pulsar · plantilla 1\n# A\n"), { matched: false });
});

test("801 a goal with no horizon followed by another goal is read, the first has no end", () => {
  const result = parseTemplate("pulsar · plantilla 1\n# A\n# B\nhorizonte: 2026-12-17\n");
  assert.ok(result.matched && "draft" in result);
  assert.deepEqual(result.draft.goals.map((g) => g.horizon), [null, "2026-12-17"]);
});

test("801 a stray text line under a goal with no horizon is a section error, not a horizon one", () => {
  const found = mistakesOf(`pulsar · plantilla 1\n# A\nhola\n${BROKEN_MONTH}`);
  assert.equal(found[0].line, 3);
  assert.notEqual(found[0].expected, "import.errors.form.horizon");
});

// Module 803: a goal name past the schema's limit says so, instead of «Falta el nombre».
test("803 name: 121 characters answer the long-name sentence on the goal's line, and cut; 120 pass", () => {
  const over = cutOf(`pulsar · plantilla 1\n# ${"a".repeat(GOAL_NAME_MAX + 1)}\nhorizonte: 2026-12-17\nmedida: d · km\n${BROKEN_MONTH}`);
  assert.deepEqual(over.errors.map((e) => e.line), [2]);
  assert.equal(over.cut, true);
  assert.equal(sentenceOf(over.errors[0].expected), "El nombre de la meta va en 120 caracteres o menos.");
  const ok = parseTemplate(`pulsar · plantilla 1\n# ${"a".repeat(GOAL_NAME_MAX)}\nhorizonte: 2026-12-17\n`);
  assert.ok(ok.matched && "draft" in ok, JSON.stringify(ok));
});

// Module 807. Two broken headers cut at the topmost, whichever reader sees it; a stray figure says what to remove.
const V1 = "pulsar · plantilla 1\n";

test("807 cut: a bad horizon above a broken «medida:» wins over the inline cut below it", () => {
  const result = cutOf(`${V1}\n# A\nhorizonte: 2027-13-45\nmedida: km\n\n## Meses\n- 2026-11x · 8 h\n`);
  assert.equal(result.cut, true);
  assert.deepEqual(result.errors, [{ line: 4, expected: "import.errors.form.horizon" }]);
});

test("807 cut: a long name in goal 1 wins over a broken «medida:» in goal 2", () => {
  const result = cutOf(`${V1}\n# ${"a".repeat(121)}\nhorizonte: 2027-10-01\n\n# B\nhorizonte: 2027-10-01\nmedida: km\n`);
  assert.equal(result.cut, true);
  assert.deepEqual(result.errors, [{ line: 3, expected: "import.errors.form.goalLong" }]);
});

test("807 cut: a broken «medida:» above a long name in goal 2 stays the cut", () => {
  const result = cutOf(`${V1}\n# A\nhorizonte: 2027-10-01\nmedida: km\n\n# ${"b".repeat(121)}\nhorizonte: 2027-10-01\n`);
  assert.equal(result.cut, true);
  assert.deepEqual(result.errors, [{ line: 5, expected: "import.errors.form.measure" }]);
});

test("807 cut: a single broken header is one error and nothing under it is judged", () => {
  const result = cutOf(`${V1}\n# A\nhorizonte: 2027-10-01\nmedida: km\n## Meses\n- x\n## Tareas\n- y\n`);
  assert.equal(result.cut, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 5);
});

test("807 cut: with no broken header every error comes at once and the reading does not cut", () => {
  const result = cutOf(`${V1}\n# A\nhorizonte: 2027-10-01\nmedida: d · km\n## Meses\n- x\n## Tareas\n- y\n`);
  assert.equal(result.cut, false);
  assert.deepEqual(result.errors.map((e) => e.line), [7, 9]);
});

test("807 stray figure: a task and a sub-task with a figure in a km goal say what to remove", () => {
  const head = `${V1}\n# A\nhorizonte: 2027-10-01\nmedida: d · km\n## Tareas\n`;
  const task = mistakesOf(`${head}- 2026-10 · 3 · Correr\n`);
  assert.deepEqual(task, [{ line: 7, expected: "import.errors.estimateNotTime" }]);
  assert.equal(said(task[0]), "Quita la cifra de esta línea: esta meta no mide tiempo.");
  const child = mistakesOf(`${head}- 2026-10 · Madre\n  - 3 · Hija\n`);
  assert.deepEqual(child, [{ line: 8, expected: "import.errors.estimateNotTime" }]);
});

const MONTH_REAL = "import.errors.form.monthReal";

test("818 month real: a task in month 13 says the month does not exist, on its own line", () => {
  assert.deepEqual(errorOf(`${HEAD}## Tareas\n- 2027-13 · 2 h · Simulacro\n`), { line: 7, expected: MONTH_REAL });
});

test("818 month real: a month in month 13 says the month does not exist", () => {
  assert.deepEqual(errorOf(`${HEAD}## Meses\n- 2026-13 · 20 h\n`), { line: 7, expected: MONTH_REAL });
});

test("818 month real: month 00 says it too, not only months past 12", () => {
  assert.equal(errorOf(`${HEAD}## Meses\n- 2026-00 · 20 h\n`).expected, MONTH_REAL);
  assert.equal(errorOf(`${HEAD}## Tareas\n- 2026-00 · 2 h · X\n`).expected, MONTH_REAL);
});

test("818 month real: a line with no month shape keeps the generic task form", () => {
  assert.equal(errorOf(`${HEAD}## Tareas\n- octubre · 2 h · X\n`).expected, "import.errors.form.task");
  assert.equal(errorOf(`${HEAD}## Meses\n- 2026-10 · 1 h\n- octubre · 20 h\n`).expected, "import.errors.form.month");
});

test("818 hrs: «8 hrs» in an hours goal reads as 480 minutes", () => {
  assert.equal(draftOf(`${HEAD}## Meses\n- 2026-12 · 8 hrs\n`).months[0].amount, 480);
});

test("818 message: the key exists in the catalogue", () => {
  assert.equal(
    catalogue.errors.form.monthReal,
    "Ese mes no existe: el mes va de 01 a 12, como «2026-10».",
  );
});

const CRITIC_PLAN = [
  "pulsar · plantilla 1",
  "",
  "# Inglés B2+ laboral",
  "horizonte: 2028-02-01",
  "medida: horas de estudio · horas",
  "",
  "## Meses",
  "- 2026-10 · 10 h",
  "- 2026-11 · 12 h",
  "- 2026-12 · 8 hrs",
  "- 2027-01 · 12 h",
  "",
  "## Compromisos",
  "- Shadowing · cada día · 15 min",
  "- Clase con tutor · martes y jueves · 1 h",
  "",
  "## Tareas",
  "- 2026-10 · 4 h · Grabar audio de referencia",
  "- 2026-11 · Elegir tutor",
  "  - 1 h · Comparar tres perfiles",
  "- 2027-13 · 2 h · Simulacro de entrevista",
  "- 2027-10 · 3 h · Preparar historias STAR",
  "",
  "# Correr 10K",
  "horizonte: 2027-04-01",
  "medida: distancia · km",
  "",
  "## Meses",
  "- 2026-10 · 40",
  "- 2026-11 · 60",
  "- 2026-12 · 70",
  "",
  "## Compromisos",
  "- Trote suave · lunes, miércoles y viernes · 5",
  "",
  "## Tareas",
  "- 2026-11 · 5 · Comprar zapatillas",
  "- 2027-01 · Carrera de prueba 5K",
].join("\n") + "\n";

test("818 critic plan: the line of 2027-13 says the month does not exist, and no generic month or task form is said", () => {
  const found = mistakesOf(CRITIC_PLAN);
  const lines = CRITIC_PLAN.split("\n");
  const real = found.filter((e) => e.expected === MONTH_REAL);
  assert.equal(real.length, 1);
  assert.equal(lines[real[0].line - 1], "- 2027-13 · 2 h · Simulacro de entrevista");
  // The km goal's «5 · Comprar zapatillas» is the 807 stray figure, a real second mistake.
  assert.deepEqual(found.filter((e) => e !== real[0]).map((e) => e.expected), ["import.errors.estimateNotTime"]);
});

test("818: only months 00 and 13+ get «ese mes no existe»; December with another fault names that fault", () => {
  const monthReal = errorOf(`${HEAD}## Meses\n- 2026-13 · 20 h\n`).expected;
  for (const line of ["- 2026-12 · 20 km", "- 2026-12 · abc", "- 2026-12 · 20"]) {
    const found = errorOf(`${HEAD}## Meses\n${line}\n`);
    assert.equal(found.line, 7, line);
    assert.notEqual(found.expected, monthReal, line);
  }
  // A well-formed December that the schema refuses for another reason (an amount past the budget's cap).
  const repeated = errorOf(`${HEAD}## Meses\n- 2026-12 · 20000 h\n`);
  assert.equal(repeated.line, 7);
  assert.notEqual(repeated.expected, monthReal);
  for (const month of ["2026-00", "2026-13", "2026-99"]) {
    assert.equal(errorOf(`${HEAD}## Meses\n- ${month} · 20 h\n`).expected, monthReal, month);
  }
});

test("818: a plain valid December line parses", () => {
  const result = parseTemplate(`${HEAD}## Meses\n- 2026-12 · 8 hrs\n`);
  assert.ok(result.matched && "draft" in result, JSON.stringify(result));
});

test("818: a month token with trailing characters gets the generic form error, never «ese mes no existe»", () => {
  const monthReal = errorOf(`${HEAD}## Meses\n- 2026-13 · 20 h\n`).expected;
  const generic = errorOf(`${HEAD}## Meses\n- octubre · 20 h\n`).expected;
  for (const month of ["2026-130", "2026-1x", "2026-001", "2026-13x"]) {
    const found = errorOf(`${HEAD}## Meses\n- ${month} · 20 h\n`);
    assert.equal(found.expected, generic, month);
    assert.notEqual(found.expected, monthReal, month);
  }
  const taskGeneric = errorOf(`${HEAD}## Tareas\n- octubre · 2 h · X\n`).expected;
  assert.equal(errorOf(`${HEAD}## Tareas\n- 2026-130 · 2 h · X\n`).expected, taskGeneric);
});
// 807: a cut names the highest broken header, whichever reading (line or schema) saw it.
// Each text has a goal whose name is over the limit on line 3; whatever else breaks sits lower.
const LONG = "a".repeat(GOAL_NAME_MAX + 1);
const HIGHEST = [{ line: 3, expected: "import.errors.form.goalLong" }];
const highestCases: Record<string, string> = {
  "a later goal that is also broken, with a broken measure": `${V1}\n# ${LONG}\nhorizonte: 2027-10-01\n# ${LONG}\nhorizonte: 2027-10-01\nmedida: km\n`,
  "a goal opened with no horizon above it": `${V1}\n# ${LONG}\n# B\nhorizonte: 2027-10-01\n`,
  "a bad rhythm among the head lines": `${V1}\n# ${LONG}\nhorizonte: 2027-10-01\nmedida: d · h\nritmo: bad\n`,
  "a horizon that is not a date": `${V1}\n# ${LONG}\nhorizonte: a b\n`,
  "a section with the horizon still missing": `${V1}\n# ${LONG}\n## Meses\n- 2026-10 · 8 h\n`,
  "a loose line before any section, horizon missing": `${V1}\n# ${LONG}\nlinea suelta\n`,
  "the end of the text, horizon missing": `${V1}\n# ${LONG}\n`,
};
for (const [what, text] of Object.entries(highestCases)) {
  test(`807 cut: a name over the limit on line 3 is the one named, over ${what}`, () => {
    const result = parseTemplate(text);
    assert.ok(result.matched && "errors" in result);
    assert.equal(result.cut, true);
    assert.deepEqual(result.errors, HIGHEST);
  });
}

// ---- Version 2: three levels, the goal's note, the lines each part came from.

const H2 = "pulsar · plantilla 2\n";
const read2 = (text: string) => {
  const result = parseV2(text);
  assert.ok(result.matched && "draft" in result, JSON.stringify(result));
  return result.draft;
};
const errors2 = (text: string) => {
  const result = parseV2(text);
  assert.ok(result.matched && "errors" in result, JSON.stringify(result));
  return result;
};

test("880 three levels: a general, a big goal inside it and a small one inside that", () => {
  const draft = read2(EXAMPLE2);
  assert.equal(draft.version, 2);
  const [general, big, small] = draft.goals;
  assert.equal(general.parent, null);
  assert.equal(big.parent, general.key);
  assert.equal(small.parent, big.key);
  assert.equal(new Set(draft.goals.map((g) => g.key)).size, 3);
  assert.deepEqual(draftRefusals(draft, "2026-10-01"), []);
});

test("880 dentro de: a name that is not before it, or comes only later, is insideUnknown on its line", () => {
  const later = errors2(`${H2}# A\nhorizonte: 2027-10-01\ndentro de: B\n# B\nhorizonte: 2027-10-01\n`);
  assert.deepEqual(later.errors.map((e) => [e.line, e.expected]), [[4, "insideUnknown"]]);
  const none = errors2(`${H2}# A\nhorizonte: 2027-10-01\ndentro de: Nadie\n`);
  assert.deepEqual(none.errors.map((e) => [e.line, e.expected]), [[4, "insideUnknown"]]);
});

test("880 dentro de: a fourth layer is insideTooDeep on its line", () => {
  const text = `${H2}# A\nhorizonte: 2027-10-01\n# B\nhorizonte: 2027-10-01\ndentro de: A\n# C\nhorizonte: 2027-10-01\ndentro de: B\n# D\nhorizonte: 2027-10-01\ndentro de: C\n`;
  assert.deepEqual(errors2(text).errors.map((e) => [e.line, e.expected]), [[12, "insideTooDeep"]]);
});

test("880 names: a goal name repeated is goalNameRepeated on the second «# » line", () => {
  const text = `${H2}# Inglés\nhorizonte: 2027-10-01\n# Inglés\nhorizonte: 2027-10-01\n`;
  assert.deepEqual(errors2(text).errors.map((e) => [e.line, e.expected]), [[4, "goalNameRepeated"]]);
});

test("880 goal note: nota: lines after medida: are the goal's note, with their lines in noteSrc", () => {
  const draft = read2(`${H2}# A\nhorizonte: 2027-10-01\nmedida: m · km\nnota: uno\nnota:\nnota: tres\n\n## Tareas\n- 2026-10 · T\n`);
  const [goal] = draft.goals;
  assert.equal(goal.note, "uno\n\ntres");
  assert.deepEqual(goal.noteSrc, [{ from: 5, to: 7 }]);
  assert.equal(goal.tasks[0].note, null);
  assert.deepEqual(goal.tasks[0].noteSrc, []);
});

test("880 goal note: all blank is no note; over the ceiling is goalNote on the first nota: line", () => {
  assert.equal(read2(`${H2}# A\nhorizonte: 2027-10-01\nnota:\nnota:\n`).goals[0].note, null);
  const head = `${H2}# A\nhorizonte: 2027-10-01\n`;
  assert.equal(read2(`${head}nota: ${"x".repeat(GOAL_NOTE_MAX)}\n`).goals[0].note?.length, GOAL_NOTE_MAX);
  const over = errors2(`${head}nota: ${"x".repeat(GOAL_NOTE_MAX + 1)}\nnota: y\n`);
  assert.deepEqual(over.errors.map((e) => [e.line, e.expected]), [[4, "goalNote"]]);
});

test("880 goal note: nota: with no indent under a section is the note form, never the goal's note", () => {
  const result = errors2(`${H2}# A\nhorizonte: 2027-10-01\n## Tareas\nnota: suelta\n- 2026-10 · T\n`);
  assert.deepEqual(result.errors.map((e) => [e.line, e.expected]), [[5, "import.errors.form.note"]]);
});

test("880 plantilla 1: reads into v2 as one layer, no goal note, same content; its extras stay stray lines", () => {
  const draft = read2("pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\n## Tareas\n- 2026-10 · T\n");
  assert.equal(draft.version, 2);
  assert.equal(draft.goals[0].parent, null);
  assert.equal(draft.goals[0].note, null);
  assert.deepEqual(draft.goals[0].tasks.map((t) => [t.name, t.estimate, t.note]), [["T", null, null]]);
  const v1extra = errors2("pulsar · plantilla 1\n# A\nhorizonte: 2027-10-01\ndentro de: B\n");
  assert.equal(v1extra.errors[0].line, 4);
  assert.equal(v1extra.errors[0].expected, "import.errors.form.section");
});

test("880 RP-72: three broken lines come back as three errors in order; a broken header answers alone, cut", () => {
  const text = `${H2}# A\nhorizonte: 2027-10-01\n## Meses\n- mal\n## Fases\n- peor\n## Tareas\n- fatal\n`;
  const result = errors2(text);
  assert.equal(result.cut, false);
  assert.deepEqual(result.errors.map((e) => e.line), [5, 7, 9]);
  const cut = errors2(`${H2}# A\nhorizonte: 2027-10-01\nmedida: sin unidad\n## Meses\n- mal\n`);
  assert.equal(cut.cut, true);
  assert.deepEqual(cut.errors.map((e) => e.line), [4]);
  const header = errors2("pulsar · plantilla 3\n# A\n");
  assert.equal(header.cut, true);
  assert.deepEqual(header.errors, [{ line: 1, expected: "import.errors.form.firstLine" }]);
});

test("880 origin: each part carries its own line, a sub-task its own, a note its nota: lines", () => {
  const lines = EXAMPLE2.split("\n");
  const at = (text: string) => lines.findIndex((l) => l === text) + 1;
  const small = read2(EXAMPLE2).goals[2];
  const [read, tutor] = small.tasks;
  assert.deepEqual(read.src, [{ from: at("- 2026-10 · 4 h · Leer AI Engineering cap. 1–4"), to: at("- 2026-10 · 4 h · Leer AI Engineering cap. 1–4") }]);
  const tutorLine = at("- 2026-10 · Tutor");
  assert.deepEqual(tutor.src, [{ from: tutorLine, to: tutorLine }]);
  assert.deepEqual(tutor.noteSrc, [{ from: tutorLine + 1, to: tutorLine + 2 }]);
  assert.deepEqual(tutor.children[0].src, [{ from: tutorLine + 3, to: tutorLine + 3 }]);
  assert.deepEqual(tutor.children[0].noteSrc, [{ from: tutorLine + 4, to: tutorLine + 4 }]);
  assert.deepEqual(tutor.children[1].src, [{ from: tutorLine + 5, to: tutorLine + 5 }]);
  const phase = at("- 2026-10-01 a 2026-12-31 · Evals y harness");
  assert.deepEqual(small.phases[0].src, [{ from: phase, to: phase }]);
  assert.deepEqual(small.months.map((m) => m.src), [[{ from: at("- 2026-10 · 12 h"), to: at("- 2026-10 · 12 h") }], [{ from: at("- 2026-11 · 20 h"), to: at("- 2026-11 · 20 h") }]]);
});

test("880 coverage: every line with text of the example is plan or note, none out", () => {
  const source = templateSource(EXAMPLE2);
  assert.equal(source.kind, "lines");
  const draft = read2(EXAMPLE2);
  const report = coverage(draft, source, new Set(), new Set());
  assert.deepEqual(report.outLines, []);
  assert.equal(report.out, 0);
  assert.equal(report.total, EXAMPLE2.split("\n").filter((l) => l.trim() !== "").length);
  assert.equal(report.notes > 0, true);
});

test("880 coverage: the header line and the section headers are counted too", () => {
  const text = `${H2}# A\nhorizonte: 2027-10-01\n## Fases\n- 2026-10-01 a 2026-12-31 · x\n`;
  const report = coverage(read2(text), templateSource(text), new Set(), new Set());
  assert.equal(report.out, 0);
  assert.equal(report.plan, 5);
});

test("880 limit: 40 goals read, the 41st is an error on its own line", () => {
  const goals = (n: number) => Array.from({ length: n }, (_, i) => `# Meta ${i}\nhorizonte: 2027-10-01\n`).join("");
  assert.equal(read2(`${H2}${goals(40)}`).goals.length, 40);
  const over = errors2(`${H2}${goals(41)}`);
  assert.deepEqual(over.errors.map((e) => e.line), [2 + 40 * 2]);
});

test("880 limit: plantilla 1 keeps its 12", () => {
  const goals = (n: number) => Array.from({ length: n }, (_, i) => `# Meta ${i}\nhorizonte: 2027-10-01\n`).join("");
  assert.equal(parseV2(`pulsar · plantilla 1\n${goals(12)}`).matched && "draft" in parseV2(`pulsar · plantilla 1\n${goals(12)}`), true);
  assert.deepEqual(errors2(`pulsar · plantilla 1\n${goals(13)}`).errors.map((e) => e.line), [2 + 12 * 2]);
});

// ---- 903: survivors of the tren-i1 mutator in the second template's reader.

test("903 dentro de: a second line naming a goal above is an error on the second line", () => {
  const text = `${H2}# A\nhorizonte: 2027-10-01\n# B\nhorizonte: 2027-10-01\n# C\nhorizonte: 2027-10-01\ndentro de: A\ndentro de: B\n`;
  assert.deepEqual(errors2(text).errors.map((e) => [e.line, e.expected]), [[9, "inside"]]);
});

test("903 dentro de: a line with no name cuts the read at that line", () => {
  const result = errors2(`${H2}# A\nhorizonte: 2027-10-01\ndentro de:\n## Tareas\n- mal\n`);
  assert.equal(result.cut, true);
  assert.deepEqual(result.errors.map((e) => [e.line, e.expected]), [[4, "inside"]]);
});

test("903 dentro de: a goal cannot be inside itself", () => {
  const result = errors2(`${H2}# A\nhorizonte: 2027-10-01\ndentro de: A\n`);
  assert.deepEqual(result.errors.map((e) => [e.line, e.expected]), [[4, "insideUnknown"]]);
});

test("903 dentro de: with no horizon above it is read, the goal has no end", () => {
  const draft = read2(`${H2}# A\nhorizonte: 2027-10-01\n# B\ndentro de: A\n`);
  assert.deepEqual(draft.goals.map((g) => [g.parent, g.horizon]), [[null, "2027-10-01"], ["g1", null]]);
});

test("903 a line two things are wrong with is listed once", () => {
  const text = `${H2}# A\nhorizonte: 2027-10-01\nmedida: m · h\n## Tareas\n- 2026-13 · 0 h · ${"x".repeat(130)}\n`;
  assert.deepEqual(errors2(text).errors.map((e) => e.line), [6]);
});

test("903 a schema refusal in the 14th goal lands on that goal's own line", () => {
  const goals = Array.from({ length: 13 }, (_, i) => `# Meta ${i}\nhorizonte: 2027-10-01\n`).join("");
  const text = `${H2}${goals}# Última\nhorizonte: 2027-10-01\n## Tareas\n- 2026-13 · T\n`;
  const lastLine = text.split("\n").length - 1;
  assert.deepEqual(errors2(text).errors.map((e) => [e.line, e.expected]), [[lastLine, "import.errors.form.monthReal"]]);
});

test("903 a goal name of exactly the ceiling reads, one more stops at its line", () => {
  assert.equal(read2(`${H2}# ${"n".repeat(GOAL_NAME_MAX)}\nhorizonte: 2027-10-01\n`).goals.length, 1);
  const over = errors2(`${H2}# ${"n".repeat(GOAL_NAME_MAX + 1)}\nhorizonte: 2027-10-01\n`);
  assert.deepEqual(over.errors.map((e) => [e.line, e.expected]), [[2, "import.errors.form.goalLong"]]);
});

// RP-102: a goal may have no end, and a rhythm counts in the measure's own unit.
const OPEN = "pulsar · plantilla 2\n";

test("915 horizonte: is optional, a goal without it has no end", () => {
  const result = parseV2(`${OPEN}# A\nmedida: horas · minutos\n`);
  assert.ok("draft" in result);
  assert.equal(result.draft.goals[0].horizon, null);
  const both = parseV2(`${OPEN}# A\n\n# B\nhorizonte: 2027-10-01\n`);
  assert.ok("draft" in both);
  assert.deepEqual(both.draft.goals.map((g) => g.horizon), [null, "2027-10-01"]);
});

test("915 horizonte: still stops when it is written wrong", () => {
  const result = parseV2(`${OPEN}# A\nhorizonte: pronto\n`);
  assert.ok("error" in result);
  assert.equal(result.error.line, 3);
});

test("915 dentro de: a goal with no end under one with an end is refused with its name", () => {
  const result = parseV2(`${OPEN}# A\nhorizonte: 2027-10-01\n\n# B\ndentro de: A\n`);
  assert.ok("draft" in result);
  const refusals = draftRefusals(result.draft, "2026-10-15");
  assert.deepEqual(refusals.map((r) => `${r.path} ${r.key}`), ["goals.1.horizon tree.errors.belowNoEnd"]);
  assert.deepEqual(refusals[0].values, { name: "B" });
  const open = parseV2(`${OPEN}# A\n\n# B\nhorizonte: 2027-10-01\ndentro de: A\n`);
  assert.ok("draft" in open);
  assert.deepEqual(draftRefusals(open.draft, "2026-10-15"), []);
});

test("915 ritmo: reads a whole number in the measure's own unit", () => {
  const result = parseV2(`${OPEN}# A\nmedida: lectura · páginas\nritmo: 40\n\n## Tareas\n- 2026-10 · Capítulo 1\n- 2026-11 · Capítulo 2\n`);
  assert.ok("draft" in result);
  assert.equal(result.draft.goals[0].rhythm, 40);
  assert.equal(result.draft.goals[0].horizon, null);
  const km = parseV2(`${OPEN}# A\nhorizonte: 2027-10-01\nmedida: carrera · km\nritmo: 10\n`);
  assert.ok("draft" in km);
  assert.equal(km.draft.goals[0].rhythm, 10);
});

test("915 ritmo: outside time stops on a time amount, on zero and on no measure", () => {
  for (const [rest, line] of [["medida: carrera · km\nritmo: 10 h\n", 5], ["medida: carrera · km\nritmo: 0\n", 5], ["ritmo: 10\n", 4]] as const) {
    const result = parseV2(`${OPEN}# A\nhorizonte: 2027-10-01\n${rest}`);
    assert.ok("error" in result, rest);
    assert.equal(result.error.line, line, rest);
  }
});

test("915 the template's own words say both things", () => {
  const doc = readFileSync(new URL("../../../../docs/pulsar/PLANTILLA.md", import.meta.url), "utf8");
  assert.match(doc, /sin `horizonte:`/);
  assert.match(doc, /entero en la unidad de la medida/);
  assert.match(doc, /pulsar · plantilla 2/);
});
