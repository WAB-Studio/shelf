import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_PROMPT } from "./prompt";

test("the prompt answers in Spanish, proposes and never claims a change made", () => {
  assert.match(SYSTEM_PROMPT, /español/);
  assert.match(SYSTEM_PROMPT, /NO está hecho/);
  assert.match(SYSTEM_PROMPT, /solo ids que una lectura/);
  assert.match(SYSTEM_PROMPT, /espera/);
});
