import assert from "node:assert/strict";
import test from "node:test";

import type { ImportDraftV1 } from "./draft";
import { repeatedGoals } from "./repeated";

function draftOf(...names: string[]): ImportDraftV1 {
  return {
    goals: names.map((name) => ({
      name,
      rhythm: null,
      horizon: "2027-10-01",
      measure: null,
      phases: [],
      months: [],
      commitments: [],
      tasks: [],
    })),
  };
}

test("one open goal of a name is an update, not a repeat", () => {
  assert.deepEqual(repeatedGoals(draftOf("IA aplicada"), ["ia  aplicada "]), []);
});

test("two open goals of a name across case and spacing are a repeat", () => {
  assert.deepEqual(repeatedGoals(draftOf("IA aplicada"), ["ia  aplicada ", "IA APLICADA"]), [0]);
});

test("accents count", () => {
  assert.deepEqual(repeatedGoals(draftOf("Inglés"), ["Ingles", "Ingles"]), []);
});

test("no open names names nothing", () => {
  assert.deepEqual(repeatedGoals(draftOf("A", "B"), []), []);
});

test("the second of three is the only one named", () => {
  assert.deepEqual(repeatedGoals(draftOf("A", "B", "C"), ["b", "B"]), [1]);
});

test("two draft goals of one doubled open name are both named, ascending", () => {
  assert.deepEqual(repeatedGoals(draftOf("X", "Y", "x"), ["X", "x"]), [0, 2]);
});

test("an accent composed or decomposed is the same letter", () => {
  assert.deepEqual(repeatedGoals(draftOf("Inglés"), ["Inglés", "Inglés"]), [0]);
});
