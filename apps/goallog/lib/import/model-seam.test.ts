import assert from "node:assert/strict";
import test from "node:test";

import { modelStub } from "./model-seam";

test("the stub is off when the variable is unset or empty", () => {
  assert.equal(modelStub(undefined, undefined), null);
  assert.equal(modelStub("", undefined), null);
});

test("the stub names fail, invalid and empty", () => {
  assert.deepEqual(modelStub("fail", undefined), { kind: "fail" });
  assert.deepEqual(modelStub("invalid", undefined), { kind: "invalid" });
  assert.deepEqual(modelStub("empty", undefined), { kind: "empty" });
});

test("a draft stub carries its fixture path", () => {
  assert.deepEqual(modelStub("draft:/tmp/plan.json", undefined), { kind: "draft", path: "/tmp/plan.json" });
});

test("a value it does not know, or a draft with no path, is off", () => {
  assert.equal(modelStub("draft:", undefined), null);
  assert.equal(modelStub("whatever", undefined), null);
});

test("production ignores the stub (VERCEL set), whatever the seam says", () => {
  for (const seam of ["fail", "invalid", "empty", "draft:/tmp/plan.json"]) {
    assert.equal(modelStub(seam, "1"), null);
  }
});

test("a padded value is trimmed", () => {
  assert.deepEqual(modelStub(" fail ", undefined), { kind: "fail" });
  assert.deepEqual(modelStub("  draft:/tmp/p.json ", undefined), { kind: "draft", path: "/tmp/p.json" });
});
