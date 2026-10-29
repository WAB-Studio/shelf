// RL-41: the model is asked for a definition only when the caller wants one
// and the dictionary gave none; the dictionary's own is never overwritten.
import assert from "node:assert/strict";
import { test } from "node:test";

import { wantsDefinition } from "./definition-need";

test("one sense with a definition means the model is not asked, whatever the caller claims", () => {
  assert.equal(wantsDefinition(true, [{ definition: "a" }, { definition: null }]), false);
  assert.equal(wantsDefinition(true, [{ definition: null }, { definition: "a" }]), false);
  assert.equal(wantsDefinition(true, [{ definition: "a" }]), false);
});

test("a caller that does not need a definition is never answered with one", () => {
  assert.equal(wantsDefinition(false, [{ definition: null }]), false);
  assert.equal(wantsDefinition(false, [{ definition: null }, { definition: null }]), false);
});

test("a caller that needs one and a group with none is asked", () => {
  assert.equal(wantsDefinition(true, [{ definition: null }]), true);
  assert.equal(wantsDefinition(true, [{ definition: null }, { definition: null }]), true);
});

test("an empty definition string is still the dictionary's definition", () => {
  assert.equal(wantsDefinition(true, [{ definition: "" }]), false);
});

test("the answer is false for every group once any sense has a definition", () => {
  for (const need of [true, false]) {
    for (let size = 1; size <= 4; size++) {
      for (let at = 0; at < size; at++) {
        const senses = Array.from({ length: size }, (_, i) => ({ definition: i === at ? "d" : null }));
        assert.equal(wantsDefinition(need, senses), false);
      }
    }
  }
});
