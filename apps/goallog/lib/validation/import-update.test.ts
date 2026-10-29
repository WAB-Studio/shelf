import assert from "node:assert/strict";
import test from "node:test";

import { parseTemplate } from "@/lib/import/template";

import { importUpdateSchema } from "./import-update";

const goalId = "6f1c9a52-3c1e-4d0e-9a43-1d2f7b8e9c10";

const parsed = parseTemplate("pulsar · plantilla 2\n\n# Leer\nhorizonte: 2999-01-01\n\n# Correr\nhorizonte: 2999-01-01\n");
if (!parsed.matched || "error" in parsed) throw new Error("the template did not parse");
const draft = parsed.draft;
const update = { g: 0, goalId, fingerprint: "month:1" };

test("a bare draft still parses, with no updates", () => {
  assert.equal(importUpdateSchema.safeParse(draft).success, true);
});

test("a draft with updates parses and keeps them", () => {
  const result = importUpdateSchema.safeParse({ draft, updates: [update, { ...update, g: 1, fingerprint: "" }] });
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(result.data).includes(goalId), true);
});

test("a goalId that is not a uuid is refused, at the update's goalId", () => {
  const result = importUpdateSchema.safeParse({ draft, updates: [{ ...update, goalId: "nope" }] });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0].path.slice(-2), [0, "goalId"]);
});

test("a malformed update is refused whatever is wrong with it", () => {
  for (const bad of [
    { ...update, g: -1 },
    { ...update, g: 1.5 },
    { ...update, g: "0" },
    { ...update, fingerprint: 7 },
    { g: 0, goalId },
    null,
  ]) {
    assert.equal(importUpdateSchema.safeParse({ draft, updates: [bad] }).success, false, JSON.stringify(bad));
  }
});

test("updates must be a list", () => {
  assert.equal(importUpdateSchema.safeParse({ draft, updates: update }).success, false);
});

// M8 (RP-56): the review sends the id its draft was saved with; a resend carries the same.
test("importUpdateSchema: a uuid requestId is kept beside the draft, one that is not a uuid is refused", () => {
  const requestId = "0b6f3c1e-2a4d-4e8f-9c7b-5d1a2e3f4b6c";
  const kept = importUpdateSchema.safeParse({ draft, updates: [], requestId });
  assert.equal(kept.success, true);
  assert.equal((kept.data as { requestId?: string }).requestId, requestId);
  assert.equal(importUpdateSchema.safeParse({ draft, updates: [], requestId: "otra-vez" }).success, false);
  assert.equal(importUpdateSchema.safeParse({ draft, updates: [] }).success, true);
});
