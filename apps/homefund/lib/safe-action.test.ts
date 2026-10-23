import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import en from "@/messages/en.json";
import es from "@/messages/es.json";

// RF-162: the database refuses with MO001 / MO002, and handleServerError is the one place that puts
// those codes into words. The real client runs; only the session read and `server-only` are doubled.
const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/db/session": "export const getSessionUser = async () => null;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) return { format: "module", source: DOUBLES[url.slice(7)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

// What drizzle throws: a wrapper that names the query, the driver's error with the sqlstate on `.cause`.
function databaseError(code: string, message = "refused"): Error {
  const driver = Object.assign(new Error(message), { code });
  return Object.assign(new Error("Failed query: insert into transactions"), { cause: driver });
}

async function answerTo(thrown: unknown): Promise<string | undefined> {
  const { actionClient } = await import("./safe-action");
  const action = actionClient.action(async () => {
    throw thrown;
  });
  const log = console.error;
  console.error = () => {};
  try {
    return (await action()).serverError as string | undefined;
  } finally {
    console.error = log;
  }
}

// Looked up by path so the file compiles before the keys exist.
function word(messages: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], messages);
}

const MOVEMENT_BEFORE_OPENING = "errors.movementBeforeOpening";
const OPENING_AFTER_MOVEMENT = "accounts.errors.openingAfterMovement";
const IMPORT_BEFORE_OPENING = "data.import.errors.beforeOpening";

test("MO001 behind a drizzle wrapper reads errors.movementBeforeOpening", async () => {
  assert.equal(await answerTo(databaseError("MO001")), MOVEMENT_BEFORE_OPENING);
});

test("MO001 thrown bare by the driver reads the same key", async () => {
  assert.equal(await answerTo(Object.assign(new Error("x"), { code: "MO001" })), MOVEMENT_BEFORE_OPENING);
});

test("MO002 reads accounts.errors.openingAfterMovement, not the movement key", async () => {
  assert.equal(await answerTo(databaseError("MO002")), OPENING_AFTER_MOVEMENT);
});

test("the two codes do not cross: each reads only its own words", async () => {
  assert.notEqual(await answerTo(databaseError("MO001")), OPENING_AFTER_MOVEMENT);
  assert.notEqual(await answerTo(databaseError("MO002")), MOVEMENT_BEFORE_OPENING);
});

test("an unknown database error and a plain Error still read errors.unexpected", async () => {
  assert.equal(await answerTo(databaseError("23505")), "errors.unexpected");
  assert.equal(await answerTo(databaseError("MO003")), "errors.unexpected");
  assert.equal(await answerTo(new Error("boom")), "errors.unexpected");
  assert.equal(await answerTo("a string"), "errors.unexpected");
});

test("an ActionError keeps the key it was thrown with, currencyMismatch included", async () => {
  const { ActionError } = await import("./errors");
  assert.equal(await answerTo(new ActionError("transactions.errors.currencyMismatch")), "transactions.errors.currencyMismatch");
  assert.equal(await answerTo(new ActionError("errors.notFound")), "errors.notFound");
});

test("the raw database message never crosses the wire", async () => {
  const answer = await answerTo(databaseError("MO001", "a movement cannot predate the opening of an account it names"));
  assert.doesNotMatch(String(answer), /predate|opening of an account/);
});

// The words the user decided (docs/DESIGN.md:443-451), in both languages.
test("the movement key reads the decided Spanish words and has an English text", () => {
  assert.equal(
    word(es, MOVEMENT_BEFORE_OPENING),
    "La fecha es anterior a la apertura de la cuenta. Cambia la fecha o la apertura de la cuenta.",
  );
  assert.equal(typeof word(en, MOVEMENT_BEFORE_OPENING), "string");
  assert.notEqual(word(en, MOVEMENT_BEFORE_OPENING), word(es, MOVEMENT_BEFORE_OPENING));
});

test("the opening key reads the decided Spanish words and has an English text", () => {
  assert.equal(
    word(es, OPENING_AFTER_MOVEMENT),
    "Hay movimientos antes de esa fecha. La apertura no puede quedar después de ellos.",
  );
  assert.equal(typeof word(en, OPENING_AFTER_MOVEMENT), "string");
  assert.notEqual(word(en, OPENING_AFTER_MOVEMENT), word(es, OPENING_AFTER_MOVEMENT));
});

test("the import key reads the decided Spanish words and has an English text", () => {
  assert.equal(word(es, IMPORT_BEFORE_OPENING), "Fecha anterior a la apertura de su cuenta.");
  assert.equal(typeof word(en, IMPORT_BEFORE_OPENING), "string");
  assert.notEqual(word(en, IMPORT_BEFORE_OPENING), word(es, IMPORT_BEFORE_OPENING));
});
