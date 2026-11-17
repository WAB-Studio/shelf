import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTranslator } from "next-intl";
import { z } from "zod";

import es from "../../messages/es.json";
import { InputRefusal, readInput } from "./input-errors";

const t = createTranslator({ locale: "es", messages: { mcp: es.mcp }, namespace: "mcp" });
const tForm = createTranslator({ locale: "es", messages: es });
const say = (key: string, values?: Record<string, string>) => t(key as never, values as never);
const known = (message: string) => (tForm.has(message as never) ? tForm(message as never) : undefined);

async function refusal(schema: z.ZodType, args: unknown): Promise<{ error: string; field?: string }> {
  try {
    await readInput(schema, args, say, known);
  } catch (error) {
    assert.ok(error instanceof InputRefusal);
    return JSON.parse(error.message);
  }
  throw new Error("the input was accepted");
}

describe("readInput", () => {
  it("returns what the schema parsed when the input is right", async () => {
    const schema = z.object({ days: z.number().int().default(3) });
    assert.deepEqual(await readInput(schema, {}, say, known), { days: 3 });
  });

  it("names a malformed UUID and a missing field, in Spanish", async () => {
    const schema = z.object({ requestRef: z.uuid(), amountCents: z.number().int() });
    assert.deepEqual(await refusal(schema, { requestRef: "no-es-uuid", amountCents: 5 }), { error: "requestRef debe ser un UUID", field: "requestRef" });
    assert.deepEqual(await refusal(schema, { amountCents: 5 }), { error: "requestRef es obligatorio", field: "requestRef" });
  });

  it("names the nested field and the limit that failed", async () => {
    const schema = z.object({ ids: z.array(z.string()).min(2), splits: z.array(z.object({ amountCents: z.number() })) });
    const refused = await refusal(schema, { ids: ["a"], splits: [{ amountCents: "5" }] });
    assert.equal(refused.field, "ids");
    assert.equal(refused.error, "ids debe traer al menos 2 elementos; splits.0.amountCents debe ser un número");
  });

  it("lists the values an enum takes", async () => {
    const refused = await refusal(z.object({ kind: z.enum(["asset", "liability"]) }), { kind: "bank" });
    assert.equal(refused.error, "kind debe ser uno de: asset, liability");
  });

  it("says a form's own refusal as the sentence the form shows", async () => {
    const schema = z.object({ name: z.string().min(1, { error: "errors.unexpected" }) });
    assert.deepEqual(await refusal(schema, { name: "" }), { error: es.errors.unexpected, field: "name" });
  });
});
