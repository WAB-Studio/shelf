import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "next-intl";

import mcp from "../../messages/es/mcp.json";
import chat from "../../messages/es/chat.json";
import { errorOf } from "../mcp/errors";
import { civilDayMonthShort } from "../zone";
import { describeChange, type ChangeNames } from "./describe";

const WRITES = Object.keys(mcp.tools).filter((name) => !/^(get|list)_/.test(name));

const G = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const P = "55555555-5555-4555-8555-555555555555";
const OTHER = "99999999-9999-4999-8999-999999999999";

const names = {
  phases: new Map([[P, { aim: "Fundamentos", startsOn: "2026-10-05", endsOn: "2026-10-25", goalId: G }]]),
  goals: new Map([
    [G, { name: "EF SET 36+", unit: "minutos", horizon: "2027-03-01", hasNote: false, months: { "2026-12": 90 }, rhythm: 600 }],
    ["44444444-4444-4444-8444-444444444444", { name: "Inglés B1", unit: null, horizon: "2027-01-01", hasNote: true, months: {} as Record<string, number>, rhythm: null }],
  ]),
  tasks: new Map([[T, { name: "Maze", month: null, day: null, hasNote: false }]]),
  commitments: new Map([[C, { name: "Repasar vocabulario", unit: null, target: null }]]),
} as ChangeNames;

const change = (tool: string, input: Record<string, unknown>) => ({ id: "c1", tool, input });

test("the catalogue holds one sentence per write tool", () => {
  assert.equal(WRITES.length, 20);
  for (const name of WRITES) {
    assert.equal(typeof (chat.change as Record<string, unknown>)[name], "string", name);
  }
});

test("a sentence's names come from the app, never from the model's text", () => {
  const out = describeChange(change("fix_task", { one_off_id: T, month: "2026-11" }), names);
  assert.deepEqual(out, { key: "chat.change.fix_task", values: { task: "Maze", month: "noviembre de 2026", before: "al plan", after: "noviembre de 2026" },
  });
});

test("an amount reads in its goal's unit", () => {
  const out = describeChange(change("set_month_amount", { goal_id: G, month: "2026-11", amount: 120 }), names);
  assert.ok("key" in out);
  assert.equal(out.values.amount, "2 h");
  assert.equal(out.values.goal, "EF SET 36+");
});

test("set_month_amount on a month with no amount reads «sin monto → 4 h»", () => {
  const out = describeChange(change("set_month_amount", { goal_id: G, month: "2026-11", amount: 240 }), names);
  assert.ok("key" in out);
  assert.equal(out.values.before, "sin monto");
  assert.equal(out.values.after, "4 h");
});

test("set_month_amount on a month that holds one reads that amount as before", () => {
  const out = describeChange(change("set_month_amount", { goal_id: G, month: "2026-12", amount: 240 }), names);
  assert.ok("key" in out);
  assert.equal(out.values.before, "1 h 30 min");
});

test("a day reads as the app's short day", () => {
  const out = describeChange(change("schedule_task", { one_off_id: T, day: "2026-11-02" }), names);
  assert.ok("key" in out);
  assert.equal(out.values.day, "2 nov");
});

test("an id the person does not own is refused before it is shown", () => {
  for (const [tool, input] of [
    ["fix_task", { one_off_id: OTHER, month: "2026-11" }],
    ["set_month_amount", { goal_id: OTHER, month: "2026-11", amount: 3 }],
    ["retire_commitment", { commitment_id: OTHER }],
    ["create_goal", { name: "X", horizon: "2027-01-01", parent_id: OTHER }],
    ["fix_task", { month: "2026-11" }],
  ] as const) {
    assert.deepEqual(describeChange(change(tool, input), names), { refused: "chat.errors.notInPlan" }, tool);
  }
});

test("a tool outside the catalogue is refused", () => {
  assert.deepEqual(describeChange(change("archive_goal", { goal_id: G }), names), { refused: "chat.errors.notInPlan" });
});

test("every tool describes itself over its own ids", () => {
  const inputs: Record<string, Record<string, unknown>> = {
    declare_fact: { commitment_id: C, day: "2026-10-12" },
    complete_task: { one_off_id: T },
    create_task: { name: "Leer", goal_id: G },
    set_task_note: { one_off_id: T, note: "x" },
    schedule_task: { one_off_id: T, day: "2026-11-02" },
    set_month_amount: { goal_id: G, month: "2026-11", amount: 4 },
    rename_goal: { goal_id: G, name: "Nuevo" },
    add_phase: { goal_id: G, aim: "Medir", starts_on: "2026-11-02", ends_on: "2026-11-30" },
    add_commitment: { goal_id: G, name: "Repasar", cadence_kind: "daily", satisfaction: "tap" },
    move_horizon: { goal_id: G, horizon: "2027-03-01" },
    fix_task: { one_off_id: T, month: "2026-11" },
    unfix_task: { one_off_id: T },
    create_goal: { name: "Meta", horizon: "2027-01-01" },
    move_goal: { goal_id: G, parent_id: null },
    set_goal_note: { goal_id: G, note: "x" },
    retire_commitment: { commitment_id: C },
    set_rhythm: { goal_id: G, amount: 600 },
    set_measure: { goal_id: G, name: "Cajas", unit: "cajas" },
    set_task_estimate: { one_off_id: T, estimate: 180 },
    edit_phase: { phase_id: P, aim: "Medir", starts_on: "2026-11-02", ends_on: "2026-11-30" },
  };
  assert.deepEqual(Object.keys(inputs).sort(), [...WRITES].sort());
  for (const name of WRITES) {
    const out = describeChange(change(name, inputs[name]), names);
    assert.ok("key" in out, name);
    assert.equal(out.key, `chat.change.${name}`);
    assert.ok(Object.values(out.values).every((v) => typeof v === "string" && v !== "undefined"), name);
  }
});

test("the chat's error keys read through errorOf", () => {
  for (const key of ["signedOut", "blank", "noKey", "cap", "capApp", "failed", "notAllowed", "notInPlan"]) {
    assert.notEqual(errorOf(`chat.errors.${key}`).key, "mcp.errors.unknown", key);
  }
});

// The words of the approved boards (NOTAS.md), pasted whole.
const BOARD_WORDS = [
  "Chat", "Hoy", "TÚ", "GOALLOG", "Hacer", "Hacer todo", "Enviar", "Mensaje",
  "Pide un cambio o pregunta por tu plan",
  "Tu mensaje y las partes de tu plan que lee se envían a OpenAI.",
  "PRUEBA CON", "¿Cómo voy este mes?", "Pon 4 h de inglés para noviembre",
  "Pensando tu mensaje…", "Esto cambiaría tu plan:", "hecho", "sin hacer",
  "No pudimos responder. Tu mensaje sigue aquí.", "Intentar otra vez",
  "Ya enviaste 50 mensajes hoy. Mañana puedes enviar otros 50. Lo que pedías aquí también se hace desde las pantallas.",
  "El chat no está disponible ahora. Tu plan sigue igual en las demás pantallas.",
  "Abrir el chat",
];

function leaves(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node !== null && typeof node === "object") return Object.values(node).flatMap(leaves);
  return [];
}

test("every board word is a value in chat.json", () => {
  const values = new Set(leaves(chat));
  const missing = BOARD_WORDS.filter((word) => !values.has(word));
  assert.deepEqual(missing, []);
});

const REFUSED = { refused: "chat.errors.notInPlan" };

test("an amount must be a whole number of at least zero: -1 and 1.5 are refused, 0 is shown", () => {
  for (const amount of [-1, -60, 1.5, "120", null]) {
    assert.deepEqual(describeChange(change("set_month_amount", { goal_id: G, month: "2026-11", amount }), names), REFUSED, String(amount));
  }
  const zero = describeChange(change("set_month_amount", { goal_id: G, month: "2026-11", amount: 0 }), names);
  assert.ok("key" in zero);
  assert.equal(zero.values.after, "0 min");
});

test("a month that is no month is refused, never drawn as a date", () => {
  for (const month of ["2026-13", "2026-00", "noviembre", "26-11", ""]) {
    assert.deepEqual(describeChange(change("fix_task", { one_off_id: T, month }), names), REFUSED, month);
  }
});

test("a day that is no calendar day is refused", () => {
  for (const day of ["2026-02-30", "2026-13-01", "mañana", "2026-11", ""]) {
    assert.deepEqual(describeChange(change("schedule_task", { one_off_id: T, day }), names), REFUSED, day);
  }
});

test("a blank name is refused and a name is shown without its edge spaces", () => {
  for (const name of ["", "   ", "\n\t"]) {
    assert.deepEqual(describeChange(change("rename_goal", { goal_id: G, name }), names), REFUSED, JSON.stringify(name));
  }
  const out = describeChange(change("rename_goal", { goal_id: G, name: "  Nuevo nombre \n" }), names);
  assert.ok("key" in out);
  assert.equal(out.values.name, "Nuevo nombre");
});

test("«antes» of a task note is the task's real state, not always «sin nota»", () => {
  const held: ChangeNames = { ...names, tasks: new Map([[T, { name: "Maze", month: null, day: null, hasNote: true }]]) };
  const had = describeChange(change("set_task_note", { one_off_id: T, note: "x" }), held);
  const none = describeChange(change("set_task_note", { one_off_id: T, note: "x" }), names);
  assert.ok("key" in had && "key" in none);
  assert.equal(had.values.before, "con nota");
  assert.equal(none.values.before, "sin nota");
  assert.match(had.values.after, /^nota nueva: «x» \(1 caracteres\), reemplaza la nota entera$/);
});

test("«antes» of a fixed task is the month it holds, «al plan» when it holds none", () => {
  const fixed: ChangeNames = { ...names, tasks: new Map([[T, { name: "Maze", month: "2026-10-01", day: null, hasNote: false }]]) };
  const from = describeChange(change("fix_task", { one_off_id: T, month: "2026-11" }), fixed);
  assert.ok("key" in from);
  assert.equal(from.values.before, "octubre de 2026");
  assert.equal(from.values.after, "noviembre de 2026");
  const unfix = describeChange(change("unfix_task", { one_off_id: T }), fixed);
  assert.ok("key" in unfix);
  assert.equal(unfix.values.before, "octubre de 2026");
  assert.equal(unfix.values.after, "al plan");
});

test("a retired commitment shows its target as «antes» only when it has one", () => {
  const none = describeChange(change("retire_commitment", { commitment_id: C }), names);
  assert.ok("key" in none);
  assert.equal(none.values.before, undefined);
  const aimed: ChangeNames = { ...names, commitments: new Map([[C, { name: "Leer", unit: "páginas", target: 5 }]]) };
  const out = describeChange(change("retire_commitment", { commitment_id: C }), aimed);
  assert.ok("key" in out);
  assert.equal(out.values.before, "5 páginas");
  const zero: ChangeNames = { ...names, commitments: new Map([[C, { name: "Leer", unit: null, target: 0 }]]) };
  const zeroOut = describeChange(change("retire_commitment", { commitment_id: C }), zero);
  assert.ok("key" in zeroOut);
  assert.equal(zeroOut.values.before, "0");
});

test("a long note is cut at 200 characters with «…» and its length said, on both tools", () => {
  const note = "a".repeat(900);
  for (const [tool, input] of [
    ["set_task_note", { one_off_id: T, note }],
    ["set_goal_note", { goal_id: G, note }],
  ] as const) {
    const out = describeChange(change(tool, input), names);
    assert.ok("key" in out, tool);
    assert.ok(out.values.after.includes(`nota nueva: «${"a".repeat(200)}…» (900 caracteres)`), tool);
    assert.ok(!out.values.after.includes("a".repeat(201)), tool);
    assert.ok(out.values.after.includes("reemplaza la nota entera"), tool);
  }
});

test("a short note is shown whole, with no «…»", () => {
  const out = describeChange(change("set_task_note", { one_off_id: T, note: "doce letras" + "!" }), names);
  assert.ok("key" in out);
  assert.ok(out.values.after.includes("nota nueva: «doce letras!» (12 caracteres)"));
  assert.ok(!out.values.after.includes("…"));
});

test("a blank note is refused", () => {
  assert.deepEqual(describeChange(change("set_goal_note", { goal_id: G, note: "  " }), names), REFUSED);
});

const PLACEHOLDERS: Record<string, string[]> = {
  declare_fact: ["commitment"],
  complete_task: ["task"],
  create_task: ["name"],
  set_task_note: ["task"],
  schedule_task: ["task"],
  set_month_amount: ["goal", "month"],
  rename_goal: ["goal"],
  add_phase: ["goal"],
  add_commitment: ["name"],
  move_horizon: ["goal"],
  fix_task: ["month", "task"],
  unfix_task: ["task"],
  create_goal: ["name"],
  move_goal: ["goal"],
  set_goal_note: ["goal"],
  retire_commitment: ["commitment"],
  set_rhythm: ["goal"],
  set_measure: ["goal"],
};

test("every change phrase opens with an infinitive and keeps its placeholders", () => {
  const phrases = chat.change as Record<string, string>;
  const sentences = Object.entries(phrases).filter(([tool]) => !tool.startsWith("note"));
  assert.deepEqual(sentences.map(([tool]) => tool).sort(), Object.keys(PLACEHOLDERS).sort());
  for (const [tool, phrase] of sentences) {
    assert.match(phrase.split(" ")[0], /^\p{L}+(ar|er|ir)(le|la|lo|se)?$/u, tool);
    const used = [...phrase.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(used, PLACEHOLDERS[tool], tool);
  }
});

test("a goal with no end is shown as «sin final», before and after", () => {
  const given = describeChange(change("move_horizon", { goal_id: G, horizon: null }), names);
  assert.ok("key" in given);
  assert.equal(given.values.after, "sin final");
  const endless: ChangeNames = {
    ...names,
    goals: new Map([[G, { name: "Leer", unit: null, horizon: null, hasNote: false, months: {}, rhythm: null }]]),
  };
  const gives = describeChange(change("move_horizon", { goal_id: G, horizon: "2027-03-01" }), endless);
  assert.ok("key" in gives);
  assert.equal(gives.values.before, "sin final");
  const created = describeChange(change("create_goal", { name: "Leer" }), names);
  assert.ok("key" in created);
  assert.equal(created.values.name, "Leer");
  const habit = describeChange(change("add_commitment", { name: "Bañarse", cadence_kind: "daily", satisfaction: "tap" }), names);
  assert.ok("key" in habit);
});

const READING = "55555555-5555-4555-8555-555555555555";
const MOVING = "66666666-6666-4666-8666-666666666666";
const withGoals: ChangeNames = {
  ...names,
  goals: new Map([
    ...names.goals,
    [READING, { name: "Leer", unit: "páginas", horizon: null, hasNote: false, months: {}, rhythm: null }],
    [MOVING, { name: "Mudanza", unit: null, horizon: null, hasNote: false, months: {}, rhythm: null }],
  ]),
};

test("set_rhythm reads «sin ritmo → 40 páginas al mes» on a goal with none (RP-119)", () => {
  const out = describeChange(change("set_rhythm", { goal_id: READING, amount: 40 }), withGoals);
  assert.deepEqual(out, {
    key: "chat.change.set_rhythm",
    values: { goal: "Leer", amount: "40 páginas", before: "sin ritmo", after: "40 páginas al mes" },
  });
  assert.equal((chat.change as Record<string, string>).set_rhythm, "Cambiar el ritmo de «{goal}»");
});

test("set_rhythm reads the rhythm the goal holds as «antes»", () => {
  const held: ChangeNames = {
    ...withGoals,
    goals: new Map([[READING, { name: "Leer", unit: "páginas", horizon: null, hasNote: false, months: {}, rhythm: 40 }]]),
  };
  const out = describeChange(change("set_rhythm", { goal_id: READING, amount: 55 }), held);
  assert.ok("key" in out);
  assert.equal(out.values.before, "40 páginas al mes");
  assert.equal(out.values.after, "55 páginas al mes");
});

test("set_rhythm in time reads in hours", () => {
  const out = describeChange(change("set_rhythm", { goal_id: G, amount: 600 }), names);
  assert.ok("key" in out);
  assert.equal(out.values.before, "10 h al mes");
  assert.equal(out.values.after, "10 h al mes");
});

test("set_measure reads «sin medida → cajas» and names the goal (RP-117)", () => {
  const out = describeChange(change("set_measure", { goal_id: MOVING, name: " Cajas embaladas ", unit: " cajas " }), withGoals);
  assert.deepEqual(out, {
    key: "chat.change.set_measure",
    values: { goal: "Mudanza", name: "Cajas embaladas", unit: "cajas", before: "sin medida", after: "cajas" },
  });
  assert.equal((chat.change as Record<string, string>).set_measure, "Ponerle medida a «{goal}»");
});

test("set_rhythm and set_measure on a goal the person has not are refused; a blank unit too", () => {
  assert.deepEqual(describeChange(change("set_rhythm", { goal_id: OTHER, amount: 40 }), withGoals), REFUSED);
  assert.deepEqual(describeChange(change("set_measure", { goal_id: OTHER, name: "x", unit: "y" }), withGoals), REFUSED);
  assert.deepEqual(describeChange(change("set_measure", { goal_id: MOVING, name: "x", unit: "  " }), withGoals), REFUSED);
  for (const amount of [null, -1, 1.5, "40"]) {
    assert.deepEqual(describeChange(change("set_rhythm", { goal_id: READING, amount }), withGoals), REFUSED, String(amount));
  }
});

const say = createTranslator({ locale: "es", messages: { chat } });
const sentence = (out: { key: string; values: Record<string, string> }) =>
  say(out.key as Parameters<typeof say>[0], out.values);

// RP-139, DESIGN «A change's line keeps the screens' words».
test("RP-139: an estimate reads «Estimar «Maze» en 3 h»", () => {
  const out = describeChange(change("set_task_estimate", { one_off_id: T, estimate: 180 }), names);
  assert.ok("key" in out);
  assert.equal(sentence(out), "Estimar «Maze» en 3 h");
});

test("RP-139: an estimate of an hour and a half reads in the app's time words", () => {
  const out = describeChange(change("set_task_estimate", { one_off_id: T, estimate: 90 }), names);
  assert.ok("key" in out);
  assert.equal(sentence(out), "Estimar «Maze» en 1 h 30 min");
});

test("RP-139: a null estimate reads «Quitar la estimación de «Maze»»", () => {
  const out = describeChange(change("set_task_estimate", { one_off_id: T, estimate: null }), names);
  assert.ok("key" in out);
  assert.equal(sentence(out), "Quitar la estimación de «Maze»");
});

test("RP-139: an estimate of a task the person does not own describes nothing", () => {
  assert.ok("key" in describeChange(change("set_task_estimate", { one_off_id: T, estimate: 60 }), names));
  assert.deepEqual(describeChange(change("set_task_estimate", { one_off_id: OTHER, estimate: 60 }), names), {
    refused: "chat.errors.notInPlan",
  });
});

test("RP-139: a phase change names the phase, the new aim and the new days", () => {
  const out = describeChange(
    change("edit_phase", { phase_id: P, aim: "Medir", starts_on: "2026-11-02", ends_on: "2026-11-30" }),
    names,
  );
  assert.ok("key" in out);
  assert.equal(out.key, "chat.change.edit_phase");
  const line = sentence(out);
  assert.match(line, /^Cambiar la fase «/);
  assert.ok(line.includes("Medir"), line);
  assert.ok(line.includes(civilDayMonthShort("2026-11-02")), line);
  assert.ok(line.includes(civilDayMonthShort("2026-11-30")), line);
  assert.ok(line.includes("→"), line);
});

test("RP-139: a phase change keeps «antes → después» in mono, the days it had and the days it takes", () => {
  const out = describeChange(
    change("edit_phase", { phase_id: P, aim: "Medir", starts_on: "2026-11-02", ends_on: "2026-11-30" }),
    names,
  );
  assert.ok("key" in out);
  const before = Object.values(out.values).join(" | ");
  assert.ok(before.includes(civilDayMonthShort("2026-10-05")), before);
  assert.ok(before.includes(civilDayMonthShort("2026-10-25")), before);
});

test("RP-139: a phase the person does not own, or a day that is no day, describes nothing", () => {
  const refused = { refused: "chat.errors.notInPlan" };
  const owned = { phase_id: P, aim: "x", starts_on: "2026-11-02", ends_on: "2026-11-30" };
  assert.ok("key" in describeChange(change("edit_phase", owned), names));
  assert.deepEqual(
    describeChange(change("edit_phase", { phase_id: OTHER, aim: "x", starts_on: "2026-11-02", ends_on: "2026-11-30" }), names),
    refused,
  );
  assert.deepEqual(
    describeChange(change("edit_phase", { phase_id: P, aim: "x", starts_on: "mañana", ends_on: "2026-11-30" }), names),
    refused,
  );
  assert.deepEqual(
    describeChange(change("edit_phase", { phase_id: P, aim: "  ", starts_on: "2026-11-02", ends_on: "2026-11-30" }), names),
    refused,
  );
});
