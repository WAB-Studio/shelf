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

test("only the last 20 turns count toward the sent text, and the cap itself is allowed", () => {
  const ok = (turns: unknown[]) => chatRequestSchema.safeParse({ turns }).success;
  const big = (n: number) => ({ role: "chat", text: "a".repeat(n), changes: [] });
  // 20 old turns of 240 000 characters stay on screen; the 20 sent are small.
  assert.equal(ok([...Array(20).fill(big(12_000)), ...Array(20).fill(person)]), true);
  const atCap = [...Array(12).fill(big(12_000)), big(4000), { role: "person", text: "a".repeat(2000) }];
  assert.equal(ok(atCap), true);
  assert.equal(ok([...atCap.slice(0, -1), { role: "person", text: "a".repeat(2001) }]), false);
  assert.equal(ok([...Array(12).fill(big(12_000)), big(4001), { role: "person", text: "a".repeat(2000) }]), false);
});

test("a change's tool name is at most 100 characters", () => {
  const ok = (tool: string) =>
    chatRequestSchema.safeParse({ turns: [{ role: "chat", text: "ok", changes: [{ tool, input: {}, state: "open" }] }, person] }).success;
  assert.equal(ok("t".repeat(100)), true);
  assert.equal(ok("t".repeat(101)), false);
});
