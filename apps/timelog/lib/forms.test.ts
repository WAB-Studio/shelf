import assert from "node:assert/strict";
import { test } from "node:test";

import { keyNameSchema, signInEmailSchema } from "./forms";

test("an address is trimmed and lowered before it is checked", () => {
  assert.equal(signInEmailSchema.parse("  Wilson@Example.COM "), "wilson@example.com");
  assert.equal(signInEmailSchema.safeParse("no es correo").success, false);
});

test("a key's name is 1 to 60 characters once trimmed", () => {
  assert.equal(keyNameSchema.safeParse("   ").success, false);
  assert.equal(keyNameSchema.parse(" PC "), "PC");
  assert.equal(keyNameSchema.safeParse("x".repeat(61)).success, false);
});
