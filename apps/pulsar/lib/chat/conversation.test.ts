import assert from "node:assert/strict";
import test from "node:test";

import { dropUnanswered, requestTurns, type StoredTurn } from "./conversation";

const stored = (state: "open" | "made" | "refused" | "lapsed") => ({ id: state, tool: "fix_task", input: { month: "2026-11" }, state });

test("the model is told which changes were made and which refused; an unmade one, lapsed or not, counts as open", () => {
  const turns: StoredTurn[] = [
    { role: "person", text: "organiza" },
    { role: "chat", text: "Esto cambiaría tu plan:", changes: [stored("open"), stored("made"), stored("refused"), stored("lapsed")] },
    { role: "person", text: "y ahora" },
  ];
  const sent = requestTurns(turns);
  const chat = sent[1];
  assert.equal(chat.role, "chat");
  assert.deepEqual(
    chat.role === "chat" ? chat.changes.map((c) => c.state) : [],
    ["open", "made", "refused", "open"],
  );
  assert.deepEqual(sent[0], { role: "person", text: "organiza" });
});

test("the request carries no id or reason of the stored change, only tool, input and state", () => {
  const sent = requestTurns([{ role: "chat", text: "x", changes: [{ ...stored("made"), reason: { text: "secreto" }, words: { key: "k", values: {} } }] }]);
  assert.deepEqual(sent[0], { role: "chat", text: "x", changes: [{ tool: "fix_task", input: { month: "2026-11" }, state: "made" }] });
});

test("a trailing person turn the model never answered leaves the history; an answered one stays", () => {
  const asked: StoredTurn[] = [
    { role: "person", text: "hola" },
    { role: "chat", text: "Hola", changes: [] },
    { role: "person", text: "x".repeat(2001) },
  ];
  assert.deepEqual(dropUnanswered(asked), asked.slice(0, 2));
  assert.deepEqual(dropUnanswered(asked.slice(0, 2)), asked.slice(0, 2));
});
