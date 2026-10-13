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
    [G, { name: "EF SET 36+", unit: "minutos" }],
    ["44444444-4444-4444-8444-444444444444", { name: "Inglés B1", unit: null }],
  ]),
  tasks: new Map([[T, { name: "Maze" }]]),
  commitments: new Map([[C, { name: "Repasar vocabulario", unit: null }]]),
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
  assert.deepEqual(out, { key: "chat.change.fix_task", values: { task: "Maze", month: "noviembre de 2026" } });
});

test("an amount reads in its goal's unit", () => {
  const out = describeChange(change("set_month_amount", { goal_id: G, month: "2026-11", amount: 120 }), names);
  assert.ok("key" in out);
  assert.equal(out.values.amount, "2 h");
  assert.equal(out.values.goal, "EF SET 36+");
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
