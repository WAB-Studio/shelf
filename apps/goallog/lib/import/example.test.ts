import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseTemplate } from "./template";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));
const DOC = readFileSync(new URL("../../../../docs/pulsar/PLANTILLA.md", import.meta.url), "utf8");
const DOC_EXAMPLE = /```\n([\s\S]*?)\n```/.exec(DOC)![1];

test("the catalogue's template example is PLANTILLA.md's, byte for byte", () => {
  assert.equal(catalogue.template.example, DOC_EXAMPLE);
});

test("the catalogue's example is a second template and reads without a mistake", () => {
  assert.ok(catalogue.template.example.startsWith("pulsar · plantilla 2\n"));
  const result = parseTemplate(catalogue.template.example);
  assert.ok(result.matched && "draft" in result);
});

test("the text for another AI carries the template whole, its mark first", () => {
  const instruction: string = catalogue.entry.instruction;
  assert.ok(instruction.includes("pulsar · plantilla 2"));
  assert.ok(instruction.includes(catalogue.template.example));
  assert.ok(instruction.includes("[pega aquí tu plan]"));
  assert.ok(instruction.endsWith(catalogue.template.example), "the template closes the text");
});

test("the example ends on a goal with no end, a rhythm in pages and its commitment", () => {
  const result = parseTemplate(catalogue.template.example);
  assert.ok(result.matched && "draft" in result);
  const goal = result.draft.goals.at(-1)!;
  assert.equal(goal.name, "Leer");
  assert.equal(goal.horizon, null);
  assert.equal(goal.measure?.unit, "páginas");
  assert.equal(goal.rhythm, 40);
  assert.ok(catalogue.template.example.endsWith("# Leer\nmedida: lectura · páginas\nritmo: 40 páginas\n\n## Compromisos\n- Leer · cada día · 10 páginas"));
});

test("the text for another AI says a goal without end goes without horizonte, and the rhythm's unit", () => {
  const line = "Una meta que no termina va sin «horizonte:». El ritmo va en la unidad de su medida: «ritmo: 12 h», «ritmo: 40 páginas».";
  const instruction: string = catalogue.entry.instruction;
  assert.ok(instruction.includes(`Máximo tres niveles.\n${line}\n`));
});

// ICU through the one formatter the app uses.
async function say(key: string, values: Record<string, string | number>): Promise<string> {
  const { createTranslator } = await import("next-intl");
  const t = createTranslator({ locale: "es", messages: { import: catalogue }, namespace: "import" });
  return (t as unknown as (k: string, v: Record<string, string | number>) => string)(key, values);
}

test("the count line says 0 fuera and 1 fuera, in lines, rows and parts", async () => {
  assert.equal(await say("review.count.lines", { total: 599, plan: 548, notes: 51, out: 0 }), "599 líneas: 548 en el plan, 51 en notas, 0 fuera");
  assert.equal(await say("review.count.lines", { total: 600, plan: 548, notes: 51, out: 1 }), "600 líneas: 548 en el plan, 51 en notas, 1 fuera");
  assert.equal(await say("review.count.lines", { total: 1, plan: 1, notes: 0, out: 0 }), "1 línea: 1 en el plan, 0 en notas, 0 fuera");
  assert.equal(await say("review.count.parts", { total: 212, plan: 190, notes: 22, out: 0 }), "212 partes: 190 en el plan, 22 en notas, 0 fuera");
  assert.equal(await say("review.count.rows", { total: 9, plan: 7, notes: 1, out: 1 }), "9 filas: 7 en el plan, 1 en notas, 1 fuera");
});

test("the workbook errors say their count and their row", async () => {
  assert.equal(await say("errors.workbookRows", { count: 3 }), "3 filas por corregir");
  assert.equal(await say("errors.workbookRows", { count: 1 }), "1 fila por corregir");
  assert.equal(await say("errors.workbookRow", { sheet: "Meses", row: 4, expected: "x" }), "Meses, fila 4: x");
});
