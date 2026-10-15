import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The specs read their words from the catalogue, so a retired word put back in a
// value passes them all; this is the one check that sees it come back.
const messagesDir = join(import.meta.dirname, "..", "messages", "es");

const retired: { word: RegExp; allowed: string[] }[] = [
  { word: /toque/i, allowed: ["import.template.example", "import.entry.instruction", "import.errors.form.commitment"] },
  { word: /se arrastr/i, allowed: [] },
  { word: /\bdebe\b/i, allowed: [] },
  { word: /umbral/i, allowed: [] },
  { word: /ya sabe otra app/i, allowed: [] },
  { word: /cero (compromisos|fases)/i, allowed: [] },
  { word: /una programada|una sin día/i, allowed: [] },
  { word: /diccionario de lectura/i, allowed: [] },
  { word: /alimentada por/i, allowed: [] },
  { word: /correr el plan/i, allowed: [] },
  { word: /mover tareas de mes/i, allowed: [] },
  { word: /aceptar que el plan corra/i, allowed: [] },
  { word: /\bagregar\b/i, allowed: ["oauth.may.phases"] },
  { word: /no mide horas/i, allowed: [] },
  { word: /este teléfono/i, allowed: [] },
];

function values(node: unknown, path: string, out: [string, string][]) {
  if (typeof node === "string") out.push([path, node]);
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) values(v, path ? `${path}.${k}` : k, out);
}

const all: [string, string][] = [];
for (const file of readdirSync(messagesDir).filter((f) => f.endsWith(".json") && f !== "mcp.json")) {
  values(JSON.parse(readFileSync(join(messagesDir, file), "utf8")), file.replace(/\.json$/, ""), all);
}

for (const { word, allowed } of retired) {
  test(`no catalogue value says ${word}`, () => {
    const found = all.filter(([key, value]) => word.test(value) && !allowed.includes(key)).map(([key]) => key);
    assert.deepEqual(found, []);
  });
}

test("the plan of a goal with no measure and the sign-in lead say the board's words", () => {
  const read = (file: string) => JSON.parse(readFileSync(join(messagesDir, file), "utf8"));
  assert.equal(
    read("roadmap.json").plan.noMeasure,
    "Esta meta no mide nada, así que no tiene ritmo: cada tarea va en el mes que le pongas.",
  );
  assert.equal(
    read("account.json").lead,
    "Te mandamos un enlace a tu correo. Ábrelo en este dispositivo y entras; no hay contraseña.",
  );
});
