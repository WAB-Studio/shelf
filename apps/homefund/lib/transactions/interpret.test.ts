import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAmount } from "@/lib/money";

import { interpretQuickEntry } from "./interpret";

const ctx = { categories: [], accounts: [], defaultAccountId: null };

// The amount the form would store for a message.
function stored(text: string): number | null {
  const { amountPesos } = interpretQuickEntry(text, ctx);
  return amountPesos === null ? null : parseAmount(amountPesos);
}

test("dot thousands read as a group", () => {
  assert.equal(stored("Compraste $12.500 en TIENDA"), 1_250_000);
});

test("comma thousands read as a group", () => {
  assert.equal(stored("Compraste 12,500 en TIENDA"), 1_250_000);
});

test("two decimals after a thousands group keep the centavos", () => {
  assert.equal(stored("Compraste $12.500,07 en TIENDA"), 1_250_007);
});

test("a recibiste message is income", () => {
  assert.equal(
    interpretQuickEntry("Recibiste una transferencia de $50.000", ctx).direction,
    "income",
  );
});

test("a message with no verb has no direction", () => {
  assert.equal(interpretQuickEntry("almuerzo 15000", ctx).direction, null);
});
