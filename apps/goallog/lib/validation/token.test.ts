import assert from "node:assert/strict";
import test from "node:test";

import { createTokenSchema, revokeTokenSchema } from "./token";

function nameError(name: unknown): string | null {
  const parsed = createTokenSchema.safeParse({ name });
  return parsed.success ? null : parsed.error.issues[0].message;
}

test("createTokenSchema: a name of 1 to 60 letters passes, trimmed", () => {
  assert.equal(nameError("a"), null);
  assert.equal(nameError("a".repeat(60)), null);
  const parsed = createTokenSchema.parse({ name: "  Claude  " });
  assert.equal(parsed.name, "Claude");
});

test("createTokenSchema: empty, blank and missing names answer nameEmpty", () => {
  assert.equal(nameError(""), "connections.errors.nameEmpty");
  assert.equal(nameError("   "), "connections.errors.nameEmpty");
  assert.equal(nameError(undefined), "connections.errors.nameEmpty");
});

test("createTokenSchema: 61 letters answer nameTooLong, 60 plus padding does not", () => {
  assert.equal(nameError("a".repeat(61)), "connections.errors.nameTooLong");
  assert.equal(nameError(` ${"a".repeat(60)} `), null);
});

test("revokeTokenSchema: a uuid passes, anything else answers notFound", () => {
  assert.equal(revokeTokenSchema.safeParse({ tokenId: "6f1c1b7e-2d4a-4f3b-9c8e-1a2b3c4d5e6f" }).success, true);
  const bad = revokeTokenSchema.safeParse({ tokenId: "nope" });
  assert.equal(bad.success ? null : bad.error.issues[0].message, "connections.errors.notFound");
});
