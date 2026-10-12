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
  assert.equal(errorOf("mcp.errors.unauthorized").message, "La llave no es válida o ya se revocó. Crea otra en Pulsar.");
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
  assert.equal(errorOf("tree.errors.noteTooLong").message, "La nota pasa de 20 000 caracteres.");
});
