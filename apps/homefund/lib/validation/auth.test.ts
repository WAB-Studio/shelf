import assert from "node:assert/strict";
import test from "node:test";

import { signInCodeSchema, signInSchema } from "./auth";

// RF-01. The sign-in address is trimmed and lowercased before its format is
// checked; every refusal carries the catalogue key, never zod's default text.

const KEY = "auth.errors.emailInvalid";

function refusal(input: unknown) {
  const result = signInSchema.safeParse(input);
  assert.equal(result.success, false);
  return result.error!.issues;
}

function assertRefusedWithKey(input: unknown) {
  const issues = refusal(input);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].path, ["email"]);
  assert.equal(issues[0].message, KEY);
}

test("an address padded with spaces signs in as its trimmed lowercase self", () => {
  assert.equal(signInSchema.parse({ email: "  Ana@Example.com " }).email, "ana@example.com");
});

test("tabs and newlines around the address are stripped", () => {
  assert.equal(signInSchema.parse({ email: "\tana@example.com\n" }).email, "ana@example.com");
  assert.equal(signInSchema.parse({ email: "\r\n ana@example.com \t" }).email, "ana@example.com");
});

test("an upper-case address is lowercased", () => {
  assert.equal(signInSchema.parse({ email: "ANA@EXAMPLE.COM" }).email, "ana@example.com");
});

test("an empty or blank address is refused with one issue on email", () => {
  assertRefusedWithKey({ email: "" });
  assertRefusedWithKey({ email: "   " });
});

test("a malformed address is refused with the catalogue key", () => {
  assertRefusedWithKey({ email: "not-an-address" });
  assertRefusedWithKey({ email: "a@b" });
  assertRefusedWithKey({ email: "  not-an-address  " });
});

test("a non-string is refused with the catalogue key, not zod's default", () => {
  assertRefusedWithKey({ email: 42 });
  assertRefusedWithKey({ email: null });
});

test("a missing email is refused", () => {
  assert.equal(signInSchema.safeParse({}).success, false);
});

test("the code schema accepts the same padded address, normalised", () => {
  const parsed = signInCodeSchema.parse({ email: "  Ana@Example.com ", code: "123456" });
  assert.equal(parsed.email, "ana@example.com");
});

test("the code schema refuses a malformed address with the same key", () => {
  const result = signInCodeSchema.safeParse({ email: "a@b", code: "123456" });
  assert.equal(result.success, false);
  const issue = result.error!.issues.find((i) => i.path[0] === "email");
  assert.equal(issue?.message, KEY);
});

test("the two schemas agree on any padding and case", () => {
  for (const raw of [" a@b.co", "A@B.CO\n", "\t X.Y@Example.Org  "]) {
    const link = signInSchema.parse({ email: raw }).email;
    const code = signInCodeSchema.parse({ email: raw, code: "000000" }).email;
    assert.equal(code, link);
    assert.equal(link, raw.trim().toLowerCase());
  }
});

// RF-146. A six-digit code pasted from the email with a space in its middle
// («123 456») reads as the six digits; spaces anywhere are not digits.
test("a code pasted with an inner space reads as its six digits", () => {
  assert.equal(signInCodeSchema.parse({ email: "a@b.co", code: "123 456" }).code, "123456");
  assert.equal(signInCodeSchema.parse({ email: "a@b.co", code: " 12 34 56\t" }).code, "123456");
});

test("a code with a letter or too few digits is still refused", () => {
  assert.equal(signInCodeSchema.safeParse({ email: "a@b.co", code: "123 45" }).success, false);
  assert.equal(signInCodeSchema.safeParse({ email: "a@b.co", code: "12a 456" }).success, false);
});
