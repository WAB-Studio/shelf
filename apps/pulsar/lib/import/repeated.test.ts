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

test("a name repeats an open one across case and spacing", () => {
  assert.deepEqual(repeatedGoals(draftOf("IA aplicada"), ["ia  aplicada "]), [0]);
});

test("accents count", () => {
  assert.deepEqual(repeatedGoals(draftOf("Inglés"), ["Ingles"]), []);
});

test("no open names names nothing", () => {
  assert.deepEqual(repeatedGoals(draftOf("A", "B"), []), []);
});

test("the second of three repeated is the only one named", () => {
  assert.deepEqual(repeatedGoals(draftOf("A", "B", "C"), ["b"]), [1]);
});

test("two goals with one open name are both named, ascending", () => {
  assert.deepEqual(repeatedGoals(draftOf("X", "Y", "x"), ["X"]), [0, 2]);
});

test("an accent composed or decomposed is the same letter", () => {
  assert.deepEqual(repeatedGoals(draftOf("Inglés"), ["Inglés"]), [0]);
});
