import assert from "node:assert/strict";
import test from "node:test";

import { chatSystemPrompt, SYSTEM_PROMPT } from "./prompt";

test("the prompt answers in Spanish, proposes and never claims a change made", () => {
  assert.match(SYSTEM_PROMPT, /español/);
  assert.match(SYSTEM_PROMPT, /NO está hecho/);
  assert.match(SYSTEM_PROMPT, /solo ids que una lectura/);
  assert.match(SYSTEM_PROMPT, /espera/);
});

test("the built prompt tells the model today's date", () => {
  assert.match(chatSystemPrompt("2026-10-15"), /Hoy es 2026-10-15 \(America\/Bogota\)/);
  assert.match(chatSystemPrompt("2027-01-03"), /2027-01-03/);
});
