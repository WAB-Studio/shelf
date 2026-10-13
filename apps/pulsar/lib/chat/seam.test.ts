import assert from "node:assert/strict";
import test from "node:test";

import { chatStub } from "./seam";

test("the stub is off whenever VERCEL is set", () => {
  assert.equal(chatStub("fail", "1"), null);
  assert.equal(chatStub("script:/x.json", "1"), null);
});

test("fail and script parse; anything else is off", () => {
  assert.deepEqual(chatStub("fail", undefined), { kind: "fail" });
  assert.deepEqual(chatStub(" script:/tmp/a.json ", undefined), { kind: "script", path: "/tmp/a.json" });
  assert.equal(chatStub("script:", undefined), null);
  assert.equal(chatStub("invalid", undefined), null);
  assert.equal(chatStub(undefined, undefined), null);
  assert.equal(chatStub("", undefined), null);
});
