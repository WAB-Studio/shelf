import assert from "node:assert/strict";
import test from "node:test";

import { challengeOf, verifierValid } from "./pkce";

// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("the appendix B verifier gives the appendix B challenge", () => {
  assert.equal(challengeOf(VERIFIER), CHALLENGE);
});

test("the appendix B verifier is valid", () => {
  assert.equal(verifierValid(VERIFIER), true);
});

test("a 42-character verifier is refused and a 43-character one passes", () => {
  assert.equal(verifierValid("a".repeat(42)), false);
  assert.equal(verifierValid("a".repeat(43)), true);
});

test("a 129-character verifier is refused and a 128-character one passes", () => {
  assert.equal(verifierValid("a".repeat(129)), false);
  assert.equal(verifierValid("a".repeat(128)), true);
});

test("a character outside the unreserved set is refused", () => {
  assert.equal(verifierValid("a".repeat(42) + "+"), false);
  assert.equal(verifierValid("a".repeat(42) + " "), false);
});
