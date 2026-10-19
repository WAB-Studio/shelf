import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { errorOf } from "./errors";

const UNKNOWN = "No se pudo completar. Revisa los datos e inténtalo otra vez.";

function keysIn(dir: string): string[] {
  const keys = new Set<string>();
  for (const file of readdirSync(new URL(dir, import.meta.url))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(new URL(`${dir}/${file}`, import.meta.url), "utf8");
    for (const [key] of source.matchAll(/"[a-zA-Z]+\.errors\.[a-zA-Z]+"/g)) keys.add(key.slice(1, -1));
  }
  return [...keys];
}

test("a key the acts return reads the catalogue's own sentence", () => {
  assert.deepEqual(errorOf("month.errors.closed"), {
    key: "month.errors.closed",
    message: "Esta meta ya terminó o está archivada.",
  });
  assert.equal(errorOf("plan.errors.phaseOverlap").message, "Esas semanas ya tienen una fase. Elige otras.");
});

test("a closed month's refusal, reads month.json's sentence", () => {
  assert.deepEqual(errorOf("month.errors.monthClosed"), {
    key: "month.errors.monthClosed",
    message: "Un mes cerrado guarda el monto con que terminó.",
  });
});

test("the server's own keys read their sentences", () => {
  assert.equal(errorOf("mcp.errors.goalNotFound").message, "Esa meta no existe o no es de esta persona.");
  assert.equal(errorOf("mcp.errors.unauthorized").message, "La llave no es válida o ya se revocó. Crea otra en GoalLog, en Conexiones.");
});

test("an unknown key is mcp.errors.unknown, key and sentence, never its own echo", () => {
  assert.deepEqual(errorOf("month.errors.nothingLikeThis"), { key: "mcp.errors.unknown", message: UNKNOWN });
});

test("a string that is no key, or names a branch or another namespace, reads unknown", () => {
  for (const key of ["", "boom", "month.errors", "month", "units.h", "month.title.x", "Error: connection refused"]) {
    assert.deepEqual(errorOf(key), { key: "mcp.errors.unknown", message: UNKNOWN }, key);
  }
});

test("every error key the acts and their schemas can return has a sentence", () => {
  const keys = [...keysIn("../../app/actions"), ...keysIn("../validation")];
  assert.ok(keys.length > 60, `only ${keys.length} keys were found`);
  for (const key of keys) {
    const { message } = errorOf(key);
    assert.notEqual(message, UNKNOWN, `${key} has no sentence`);
    assert.notEqual(message, key, `${key} resolved to its own name`);
  }
});

test("a path that reaches a sentence but has no key's shape reads unknown", () => {
  assert.deepEqual(errorOf("mcp.instructions"), { key: "mcp.errors.unknown", message: UNKNOWN });
});

test("a tree refusal carries the goal's name and the day in its sentence", () => {
  assert.equal(
    errorOf("tree.errors.endPastAbove", { name: "Leer más", date: "2027-09-30" }).message,
    "Pasa del final de «Leer más», el 30 sep 2027.",
  );
  assert.equal(errorOf("tree.errors.aboveArchived", { name: "Leer más" }).message, "«Leer más» está archivada. Reábrela primero.");
  assert.equal(errorOf("tree.errors.noteTooLong").message, "La nota pasa de 100 000 caracteres.");
});

// M19 · a refusal reads a tool-specific sentence when one exists (RP-119).

const COMBINATION =
  "Combinación no válida. Usa una de estas: suelta (solo name, y day opcional); del mes (goal_id + planned_month, sin day); en el plan (goal_id + in_plan: true, sin day ni parent_id); sub-tarea (parent_id, sin goal_id ni planned_month ni day).";
const TASK_NOT_FOUND = "No hay una tarea o compromiso con ese id para esta persona. Lee los ids con get_goal, get_today o list_loose_one_offs.";
const PLAN_NOT_FOUND = "No hay nada con ese id para esta persona. Vuelve a leerlo con list_goals o get_goal.";
const FIELD_INVALID = "Algún campo no es válido. Revisa el formato: ids uuid, meses AAAA-MM, días AAAA-MM-DD, montos enteros.";

test("create_task's invalid refusal tells which combinations are valid, and keeps its key", () => {
  assert.deepEqual(errorOf("month.errors.invalid", undefined, "create_task"), { key: "month.errors.invalid", message: COMBINATION });
});

test("the tool's own sentence wins over the wildcard for the same key", () => {
  assert.notEqual(errorOf("month.errors.invalid", undefined, "create_task").message, FIELD_INVALID);
  assert.equal(errorOf("month.errors.invalid", undefined, "create_task").message, COMBINATION);
});

test("a tool with no sentence of its own reads the wildcard for the key", () => {
  assert.deepEqual(errorOf("day.errors.notFound", undefined, "complete_task"), { key: "day.errors.notFound", message: TASK_NOT_FOUND });
  assert.equal(errorOf("plan.errors.notFound", undefined, "rename_goal").message, PLAN_NOT_FOUND);
  assert.equal(errorOf("month.errors.invalid", undefined, "rename_goal").message, FIELD_INVALID);
  assert.equal(errorOf("day.errors.notFound", undefined, "no_such_tool").message, TASK_NOT_FOUND);
});

test("the screen's call, with no tool, reads today's sentence", () => {
  assert.equal(errorOf("month.errors.invalid").message, "Eso no es válido.");
  assert.equal(errorOf("day.errors.notFound").message, "Eso ya no existe. Recarga la página.");
  assert.equal(errorOf("plan.errors.notFound").message, "Eso ya no existe.");
});

test("a key with neither a tool sentence nor a wildcard reads today's path, with or without a tool", () => {
  assert.equal(errorOf("month.errors.closed", undefined, "create_task").message, "Esta meta ya terminó o está archivada.");
  assert.equal(errorOf("plan.errors.phaseOverlap", undefined, "add_phase").message, "Esas semanas ya tienen una fase. Elige otras.");
});

test("a tool never turns an unknown key into a sentence", () => {
  assert.deepEqual(errorOf("boom", undefined, "create_task"), { key: "mcp.errors.unknown", message: UNKNOWN });
  assert.deepEqual(errorOf("month.errors.nothingLikeThis", undefined, "create_task"), { key: "mcp.errors.unknown", message: UNKNOWN });
});

test("a tool-less key that merely looks like an override is no sentence", () => {
  for (const key of ["*:day.errors.notFound", "create_task:month.errors.invalid", "mcp.errors.byTool"]) {
    assert.deepEqual(errorOf(key, undefined, "create_task"), { key: "mcp.errors.unknown", message: UNKNOWN }, key);
  }
});

test("a tool still fills the name and the day of a refusal", () => {
  assert.equal(
    errorOf("tree.errors.endPastAbove", { name: "Leer más", date: "2027-09-30" }, "move_horizon").message,
    "Pasa del final de «Leer más», el 30 sep 2027.",
  );
});
