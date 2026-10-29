import assert from "node:assert/strict";
import test from "node:test";

import { chatSystemPrompt, SYSTEM_PROMPT } from "./prompt";

test("the prompt answers in Spanish, proposes and never claims a change made", () => {
  assert.match(SYSTEM_PROMPT, /español/);
  assert.match(SYSTEM_PROMPT, /NO está hecho/);
  assert.match(SYSTEM_PROMPT, /solo ids que una lectura/);
  assert.match(SYSTEM_PROMPT, /espera/);
});

test("a task missing from get_today is looked up in list_loose_one_offs before asking which", () => {
  assert.match(SYSTEM_PROMPT, /no está en get_today, puede estar en list_loose_one_offs \(la de una meta o una suelta\)[^\n]*antes de preguntar/);
});

test("the built prompt tells the model today's date", () => {
  assert.match(chatSystemPrompt("2026-10-15"), /Hoy es 2026-10-15 \(America\/Bogota\)/);
  assert.match(chatSystemPrompt("2027-01-03"), /2027-01-03/);
});

// RP-139: the chat can propose both, so the list of what it cannot do never names them.
test("RP-139: the «no puedes» rule names neither an estimate nor a phase", () => {
  const rule = SYSTEM_PROMPT.split("\n").find((line) => /no puedes/i.test(line));
  assert.ok(rule, "the prompt keeps a «no puedes» rule");
  assert.match(rule, /borrar/);
  assert.match(rule, /archivar/);
  assert.doesNotMatch(rule, /estim/i);
  assert.doesNotMatch(rule, /fase/i);
});

test("RP-139: nothing in the built prompt tells the model it cannot estimate or change a phase", () => {
  const built = chatSystemPrompt("2026-10-18");
  assert.doesNotMatch(built, /no puedes[^\n]*(estim|fase)/i);
  assert.doesNotMatch(built, /(estim|fase)[^\n]*no puedes/i);
});
