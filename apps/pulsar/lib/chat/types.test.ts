import assert from "node:assert/strict";
import test from "node:test";

import { chatRequestSchema } from "./types";

const person = { role: "person", text: "hola" } as const;
const chat = { role: "chat", text: "ok", changes: [{ tool: "fix_task", input: {}, state: "open" }] } as const;

test("a request ends on the person's turn and holds 1 to 40 turns", () => {
  assert.equal(chatRequestSchema.safeParse({ turns: [person] }).success, true);
  assert.equal(chatRequestSchema.safeParse({ turns: [person, chat] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ turns: [] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ turns: Array(41).fill(person) }).success, false);
  assert.equal(chatRequestSchema.safeParse({ turns: Array(40).fill(person) }).success, true);
});

test("a person's text is 1 to 2000 characters", () => {
  assert.equal(chatRequestSchema.safeParse({ turns: [{ role: "person", text: "" }] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ turns: [{ role: "person", text: "a".repeat(2001) }] }).success, false);
});
