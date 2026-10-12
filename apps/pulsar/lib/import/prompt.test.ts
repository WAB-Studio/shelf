import assert from "node:assert/strict";
import test from "node:test";

import { numberLines, SYSTEM_PROMPT } from "./prompt";

test("numberLines puts the line number and a bar before each line", () => {
  assert.equal(numberLines("a\nb\r\nc"), "1|a\n2|b\n3|c");
  assert.equal(numberLines("solo"), "1|solo");
});

test("the prompt asks the three steps in order", () => {
  const find = SYSTEM_PROMPT.search(/\bfind\b/i);
  const arrange = SYSTEM_PROMPT.search(/\barrange\b/i);
  assert.ok(find >= 0 && arrange > find);
  assert.match(SYSTEM_PROMPT, /context/i);
});

test("the prompt puts every line in a part, a note or nowhere, and invents nothing", () => {
  assert.match(SYSTEM_PROMPT, /nowhere|no part/i);
  assert.match(SYSTEM_PROMPT, /invent nothing/i);
  assert.match(SYSTEM_PROMPT, /note/i);
});

test("the prompt asks src and noteSrc copied, and steps of a task in its noteSrc", () => {
  assert.match(SYSTEM_PROMPT, /\bsrc\b/);
  assert.match(SYSTEM_PROMPT, /noteSrc/);
  assert.match(SYSTEM_PROMPT, /steps/i);
});

test("the prompt asks hours when the plan counts hours, the rate with its period, weeks as tasks, rules per week", () => {
  assert.match(SYSTEM_PROMPT, /hours/i);
  assert.match(SYSTEM_PROMPT, /\brate\b/);
  assert.match(SYSTEM_PROMPT, /\bper\b|period/i);
  assert.match(SYSTEM_PROMPT, /weeks?\b.*tasks?|tasks?.*weeks?/is);
  assert.match(SYSTEM_PROMPT, /rules?.*(per|each|every) week|per week/is);
});

test("the prompt says the bounds the answer keeps", () => {
  assert.match(SYSTEM_PROMPT, /120/);
  assert.match(SYSTEM_PROMPT, /three levels/i);
});
