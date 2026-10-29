import assert from "node:assert/strict";
import { test } from "node:test";

import { bearerOf, fingerprint, mintKey } from "./key-format";

test("a minted key reads back as its own bearer and hashes to its stored fingerprint", () => {
  const { key, hash, hint } = mintKey();
  assert.match(key, /^tl_[A-Za-z0-9_-]{43}$/);
  assert.equal(bearerOf(`Bearer ${key}`), key);
  assert.deepEqual(fingerprint(key), hash);
  assert.equal(hint, key.slice(-4));
});

test("anything but `Bearer tl_<43>` is no bearer", () => {
  const { key } = mintKey();
  for (const header of [null, "", key, `bearer ${key}`, `Bearer ${key} `, `Bearer pls_${key.slice(3)}`, `Bearer ${key.slice(0, -1)}`]) {
    assert.equal(bearerOf(header), null, String(header));
  }
});
