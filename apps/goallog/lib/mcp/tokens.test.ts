import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before, mock } from "node:test";

// `@/db/client` imports `server-only`, which throws outside Next.
mock.module("@/db/client", { namedExports: { db: {} } });

let fingerprint: typeof import("./tokens").fingerprint;
let mintKey: typeof import("./tokens").mintKey;

before(async () => {
  ({ fingerprint, mintKey } = await import("./tokens"));
});

test("a minted key is pls_ and 43 base64url characters", () => {
  assert.match(mintKey().key, /^pls_[A-Za-z0-9_-]{43}$/);
});

test("a minted key carries 32 random bytes after its prefix", () => {
  const { key } = mintKey();
  assert.equal(Buffer.from(key.slice("pls_".length), "base64url").length, 32);
});

test("two mints differ", () => {
  assert.notEqual(mintKey().key, mintKey().key);
});

test("the hint is the key's last four characters", () => {
  const { key, hint } = mintKey();
  assert.equal(hint.length, 4);
  assert.equal(key.endsWith(hint), true);
});

test("the hash is the SHA-256 of the whole key, prefix included", () => {
  const { key, hash } = mintKey();
  assert.equal(hash.length, 32);
  assert.equal(hash.toString("hex"), createHash("sha256").update(key).digest("hex"));
});

test("fingerprint is 32 bytes and deterministic", () => {
  assert.equal(fingerprint("abc").length, 32);
  assert.deepEqual(fingerprint("abc"), fingerprint("abc"));
  assert.notDeepEqual(fingerprint("abc"), fingerprint("abd"));
});
