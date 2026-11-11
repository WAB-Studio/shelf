import assert from "node:assert/strict";
import { test } from "node:test";

import { applyRecipient, extractNumber, matchRecipient, type RecipientRule } from "./recipient-number";

test("the destination account of a transfer is read from the notice", () => {
  assert.equal(
    extractNumber("Bancolombia: Transferiste $60.000 desde tu cuenta *3397 a la cuenta *3203359119 el 11/11/2026 05:48."),
    "3203359119",
  );
});

test("a key and a tail are read as well", () => {
  assert.equal(extractNumber("Transferiste $20.000 a la llave 3203359119 el 11/11/2026"), "3203359119");
  assert.equal(extractNumber("Transferiste $20.000 a la cuenta *6870"), "6870");
});

test("the source of a received transfer is read when it is a number", () => {
  assert.equal(extractNumber("Recibiste una transferencia de 3203359119 por $50.000"), "3203359119");
});

test("a message naming no number gives none", () => {
  assert.equal(extractNumber("Recibiste $50.000 de BRAYAN SUAREZ en tu cuenta *3397 el 11/11/2026"), null);
  assert.equal(extractNumber("Compraste $12.500 en BOLD CO ONLINE con tu T.Cred *4872"), null);
  assert.equal(extractNumber("Transferiste $60.000 desde tu cuenta *3397 a la llave @brayan"), null);
});

const rule = (over: Partial<RecipientRule>): RecipientRule => ({
  id: "r1",
  identifier: "3203359119",
  name: "Nequi de mamá",
  kind: "payee",
  accountId: null,
  categoryId: null,
  ...over,
});

test("a tail matches the number that ends with it, and two matches are none", () => {
  const one = rule({ identifier: "3203359119" });
  const two = rule({ id: "r2", identifier: "3105559119" });
  assert.equal(matchRecipient("3203359119", [one, two]), one);
  assert.equal(matchRecipient("359119", [one, two]), one);
  assert.equal(matchRecipient("9119", [one, two]), null);
  assert.equal(matchRecipient("0000", [one, two]), null);
  assert.equal(matchRecipient(null, [one]), null);
});

test("an own account makes a transfer out of the bank account the message names", () => {
  const got = applyRecipient({ direction: "expense", accountId: "bank" }, rule({ kind: "own_account", accountId: "nequi" }));
  assert.deepEqual(got, { direction: "transfer", accountId: "bank", toAccountId: "nequi", categoryId: null, description: "Nequi de mamá" });
});

test("a number received from an own account is a transfer into the bank account", () => {
  const got = applyRecipient({ direction: "income", accountId: "bank" }, rule({ kind: "own_account", accountId: "nequi" }));
  assert.equal(got.direction, "transfer");
  assert.equal(got.accountId, "nequi");
  assert.equal(got.toAccountId, "bank");
});

test("a person without an account only gives the description, a payee gives its category", () => {
  const person = applyRecipient({ direction: "expense", accountId: "bank" }, rule({ kind: "person" }));
  assert.deepEqual(person, { direction: "expense", accountId: "bank", toAccountId: null, categoryId: null, description: "Nequi de mamá" });
  const payee = applyRecipient({ direction: null, accountId: "bank" }, rule({ kind: "payee", categoryId: "rent" }));
  assert.equal(payee.direction, "expense");
  assert.equal(payee.categoryId, "rent");
});
