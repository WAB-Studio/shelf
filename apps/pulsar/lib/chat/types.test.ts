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

test("a chat turn, its changes and the turns sent are bounded", () => {
  const ok = (turns: unknown[]) => chatRequestSchema.safeParse({ turns }).success;
  const big = (n: number) => ({ role: "chat", text: "a".repeat(n), changes: [] });
  assert.equal(ok([big(12_000), person]), true);
  assert.equal(ok([big(12_001), person]), false);
  assert.equal(ok([...Array(10).fill(big(12_000)), ...Array(9).fill(person), { role: "person", text: "a".repeat(2000) }]), true);
  assert.equal(ok([...Array(19).fill(big(12_000)), person]), false);
  const change = (input: Record<string, unknown>) => ({ role: "chat", text: "ok", changes: [{ tool: "fix_task", input, state: "open" }] });
  assert.equal(ok([change({ note: "a".repeat(7000) }), person]), true);
  assert.equal(ok([change({ note: "a".repeat(8000) }), person]), false);
  assert.equal(ok([{ role: "chat", text: "ok", changes: Array(51).fill({ tool: "t", input: {}, state: "open" }) }, person]), false);
});
