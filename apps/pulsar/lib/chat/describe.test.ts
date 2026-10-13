import assert from "node:assert/strict";
import test from "node:test";

import mcp from "../../messages/es/mcp.json";
import chat from "../../messages/es/chat.json";
import { errorOf } from "../mcp/errors";
import { describeChange, type ChangeNames } from "./describe";

const WRITES = Object.keys(mcp.tools).filter((name) => !/^(get|list)_/.test(name));

const G = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const OTHER = "99999999-9999-4999-8999-999999999999";

const names: ChangeNames = {
  goals: new Map([
    [G, { name: "EF SET 36+", unit: "minutos", horizon: "2027-03-01", hasNote: false, months: { "2026-12": 90 } }],
    ["44444444-4444-4444-8444-444444444444", { name: "Inglés B1", unit: null, horizon: "2027-01-01", hasNote: true, months: {} as Record<string, number> }],
  ]),
  tasks: new Map([[T, { name: "Maze", month: null, day: null, hasNote: false }]]),
  commitments: new Map([[C, { name: "Repasar vocabulario", unit: null, target: null }]]),
};

const change = (tool: string, input: Record<string, unknown>) => ({ id: "c1", tool, input });

test("the catalogue holds one sentence per write tool", () => {
  assert.equal(WRITES.length, 16);
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
  for (const key of ["signedOut", "blank", "noKey", "cap", "failed", "notAllowed", "notInPlan"]) {
    assert.notEqual(errorOf(`chat.errors.${key}`).key, "mcp.errors.unknown", key);
  }
});

// The words of the approved boards (NOTAS.md), pasted whole.
const BOARD_WORDS = [
  "Chat", "Hoy", "TÚ", "PULSAR", "Hacer", "Hacer todo", "Enviar", "Mensaje",
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
  assert.equal(had.values.after, "con nota");
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
};

test("every change phrase opens with an infinitive and keeps its placeholders", () => {
  const phrases = chat.change as Record<string, string>;
  assert.deepEqual(Object.keys(phrases).sort(), Object.keys(PLACEHOLDERS).sort());
  for (const [tool, phrase] of Object.entries(phrases)) {
    assert.match(phrase.split(" ")[0], /^\p{L}+(ar|er|ir)$/u, tool);
    const used = [...phrase.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(used, PLACEHOLDERS[tool], tool);
  }
});
