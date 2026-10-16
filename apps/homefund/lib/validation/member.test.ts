import assert from "node:assert/strict";
import { test } from "node:test";

import * as memberValidation from "./member";

const { inviteByEmailSchema, provisionalMemberName } = memberValidation as unknown as {
  inviteByEmailSchema: import("zod").ZodType;
  provisionalMemberName: (email: string) => string;
};

function addressOfLength(length: number): string {
  const suffix = "@example.com";
  return `${"a".repeat(length - suffix.length)}${suffix}`;
}

function messages(input: unknown): string[] {
  const result = inviteByEmailSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test("a valid address longer than the name's cap is accepted by the invite schema", () => {
  const email = addressOfLength(81);
  assert.equal(email.length, 81);
  assert.equal(inviteByEmailSchema.safeParse({ email }).success, true);
  assert.equal(inviteByEmailSchema.safeParse({ email: addressOfLength(120) }).success, true);
});

test("a padded address is trimmed", () => {
  const result = inviteByEmailSchema.safeParse({ email: "  ana@example.com " });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { email: "ana@example.com" });
});

test("an address padded on both sides parses to the bare address", () => {
  const result = inviteByEmailSchema.safeParse({ email: " ana@x.invalid " });
  assert.equal(result.success, true);
  assert.equal((result.data as { email: string }).email, "ana@x.invalid");
});

test("a blank or missing address is refused with the email-invalid key", () => {
  for (const input of [{ email: "" }, { email: "   " }, {}]) {
    assert.deepEqual(messages(input), ["members.errors.emailInvalid"], JSON.stringify(input));
  }
});

test("a malformed address is refused with the email-invalid key", () => {
  for (const email of ["ana@", "ana", "@example.com", "ana example@x.com"]) {
    assert.deepEqual(messages({ email }), ["members.errors.emailInvalid"], email);
  }
});

test("the provisional name is the address cut to the name's cap of 80", () => {
  assert.equal(provisionalMemberName(addressOfLength(81)).length, 80);
  assert.equal(provisionalMemberName(addressOfLength(200)), addressOfLength(200).slice(0, 80));
  assert.equal(provisionalMemberName(addressOfLength(80)), addressOfLength(80));
  assert.equal(provisionalMemberName("ana@example.com"), "ana@example.com");
});

test("the provisional name always passes the member-name schema", () => {
  for (const length of [30, 80, 81, 254]) {
    const name = provisionalMemberName(addressOfLength(length));
    assert.equal(memberValidation.createMemberSchema.safeParse({ name }).success, true, `${length}`);
  }
});
