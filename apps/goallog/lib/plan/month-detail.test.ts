import assert from "node:assert/strict";
import test from "node:test";

import { monthDetail } from "./month-detail";

test("a state and a count join with « · », state first", () => {
  assert.equal(monthDetail("en curso", "2 tareas"), "en curso · 2 tareas");
  assert.equal(monthDetail("planeado", "1 tarea"), "planeado · 1 tarea");
});

test("a count with no state reads alone: «3 tareas»", () => {
  assert.equal(monthDetail(null, "3 tareas"), "3 tareas");
});

test("a state with no count reads as it did", () => {
  assert.equal(monthDetail("en curso", null), "en curso");
});

test("neither reads nothing", () => {
  assert.equal(monthDetail(null, null), null);
});
