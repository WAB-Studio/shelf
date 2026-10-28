import assert from "node:assert/strict";
import { test } from "node:test";

import { BRIEF_DONE, BRIEF_NEXT, BRIEF_NOTE, claudeBrief, claudeChatHref, type BriefInput } from "./claude-brief";

const task = (id: string, name: string, extra: Partial<BriefInput["tasks"][number]> = {}) => ({
  id,
  parentId: null,
  name,
  plannedMonth: "2026-10-01",
  day: null,
  estimate: null,
  doneOn: null,
  ...extra,
});

const base: BriefInput = {
  name: "Inglés B2",
  note: null,
  phases: [],
  tasks: [],
  month: null,
  today: "2026-10-28",
};

test("the brief names the goal, what was done in the last seven days with its notes, and what is open this month", () => {
  const brief = claudeBrief({
    ...base,
    note: "Examen en marzo",
    phases: [{ name: "Gramática", startsOn: "2026-10-01", endsOn: "2026-11-30" }],
    month: { reached: "4 h", planned: "10 h" },
    tasks: [
      task("a", "Lectura cap. 1", { doneOn: "2026-10-26", note: "costó el vocabulario" }),
      task("b", "Lectura cap. 2", { doneOn: "2026-10-27" }),
      task("old", "Diagnóstico", { doneOn: "2026-10-21" }),
      task("c", "Ensayo de escritura"),
      task("nov", "Simulacro", { plannedMonth: "2026-11-01" }),
    ],
  });
  assert.match(brief, /^Estoy siguiendo mi meta «Inglés B2» en GoalLog\./);
  assert.match(brief, /Nota de la meta: Examen en marzo/);
  assert.match(brief, /Fase actual: Gramática, hasta el 30 nov\./);
  assert.match(brief, /Este mes llevo 4 h de 10 h\./);
  assert.match(brief, /- 26 oct: Lectura cap\. 1 \(nota: costó el vocabulario\)\n- 27 oct: Lectura cap\. 2/);
  assert.doesNotMatch(brief, /Diagnóstico/, "a task done eight days ago is out of the brief");
  assert.match(brief, /Lo que sigue:\n- Ensayo de escritura\n/);
  assert.doesNotMatch(brief, /Simulacro/, "next month's task waits for its month");
  assert.match(brief, /Hoy es 28 oct\./);
});

test("a parent is no task to do: its open sub-tasks are, in its month", () => {
  const brief = claudeBrief({
    ...base,
    tasks: [task("p", "Mudanza"), task("k", "Empacar", { parentId: "p", plannedMonth: null })],
  });
  assert.match(brief, /- Empacar/);
  assert.doesNotMatch(brief, /- Mudanza/);
});

test("with nothing done and nothing open, the brief says so instead of drawing empty lists", () => {
  const brief = claudeBrief(base);
  assert.match(brief, /Estos días no anoté nada hecho\./);
  assert.match(brief, /No tengo tareas pendientes este mes\./);
});

test("the open list stops at its cap", () => {
  const many = Array.from({ length: BRIEF_NEXT + 5 }, (_, i) => task(`t${i}`, `Tarea ${i}`));
  const brief = claudeBrief({ ...base, tasks: many });
  assert.equal(brief.match(/^- Tarea /gm)?.length, BRIEF_NEXT);
});

test("the link opens a new claude.ai chat with the brief in its box", () => {
  const href = claudeChatHref("Hola «meta»\n- uno");
  assert.ok(href.startsWith("https://claude.ai/new?q="));
  assert.equal(decodeURIComponent(href.slice("https://claude.ai/new?q=".length)), "Hola «meta»\n- uno");
});

test("a task left undone in an earlier month is still open: it carries into this one", () => {
  const brief = claudeBrief({ ...base, tasks: [task("s", "Repaso de septiembre", { plannedMonth: "2026-09-01" })] });
  assert.match(brief, /Lo que sigue:\n- Repaso de septiembre/);
});

test("a note reads on one line, cut whole at its cap, and a blank one is no note", () => {
  const long = `${"a".repeat(BRIEF_NOTE - 1)}😀😀 resto`;
  const brief = claudeBrief({
    ...base,
    note: "   ",
    tasks: [
      task("m", "Multilínea", { doneOn: "2026-10-27", note: "uno\n- falso ítem" }),
      task("l", "Larga", { doneOn: "2026-10-28", note: long }),
    ],
  });
  assert.doesNotMatch(brief, /Nota de la meta/);
  assert.match(brief, /Multilínea \(nota: uno - falso ítem\)/);
  assert.match(brief, new RegExp(`Larga \\(nota: a{${BRIEF_NOTE - 1}}😀…\\)`));
  assert.doesNotThrow(() => claudeChatHref(brief));
});

test("a busy week keeps its latest days and says how many more came before", () => {
  const many = Array.from({ length: BRIEF_DONE + 3 }, (_, i) =>
    task(`d${i}`, `Hecha ${String(i).padStart(2, "0")}`, { doneOn: i < 3 ? "2026-10-22" : "2026-10-28" }),
  );
  const brief = claudeBrief({ ...base, tasks: many });
  assert.equal(brief.match(/^- \d+ oct: Hecha /gm)?.length, BRIEF_DONE);
  assert.match(brief, /- … y 3 más antes/);
  assert.doesNotMatch(brief, /Hecha 00/);
  assert.match(brief, /Hoy es 28 oct\./, "the closing question is never cut");
});
