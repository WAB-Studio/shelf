import { createHash } from "node:crypto";

// RFC 7636 §4.1: 43 to 128 characters of the unreserved set.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export function verifierValid(verifier: string): boolean {
  return VERIFIER.test(verifier);
}

export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
