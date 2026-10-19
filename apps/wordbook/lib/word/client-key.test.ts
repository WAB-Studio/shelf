// The address itself must never survive past this function — every
// assertion below reads the hash, never the header value it was built
// from.
import assert from "node:assert/strict";
import { test } from "node:test";

import { clientKey, clientKeyFromAddress, clientKeyFromHeaders, scopeClientKey } from "./client-key";

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/word/unlisted", { headers });
}

test("no salt configured means no key, whatever the caller sends", () => {
  assert.equal(clientKey(request({ "x-forwarded-for": "203.0.113.9" }), undefined), null);
});

test("no address at all means no key, salt or not", () => {
  assert.equal(clientKey(request({}), "a-real-salt-value"), null);
});

test("the same address and salt hash to the same key", () => {
  const a = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  const b = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  assert.ok(a);
  assert.equal(a, b);
});

test("a different address hashes to a different key", () => {
  const a = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  const b = clientKey(request({ "x-forwarded-for": "203.0.113.10" }), "a-real-salt-value");
  assert.notEqual(a, b);
});

test("a different salt hashes the same address to a different key", () => {
  const a = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "salt-one-value");
  const b = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "salt-two-value");
  assert.notEqual(a, b);
});

test("the key is a hash, never the address it was built from", () => {
  const key = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  assert.ok(key);
  assert.ok(!key.includes("203.0.113.9"));
});

test("x-forwarded-for's first hop is the address, the rest is the proxy chain", () => {
  const first = clientKey(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), "a-real-salt-value");
  const solo = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  assert.equal(first, solo);
});

test("whitespace around the first hop does not change the key", () => {
  const padded = clientKey(request({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" }), "a-real-salt-value");
  const bare = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  assert.equal(padded, bare);
});

test("x-real-ip is the fallback when x-forwarded-for is absent", () => {
  const viaRealIp = clientKey(request({ "x-real-ip": "203.0.113.9" }), "a-real-salt-value");
  const viaForwardedFor = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  assert.equal(viaRealIp, viaForwardedFor);
});

test("x-forwarded-for wins over x-real-ip when both are present", () => {
  const both = clientKey(
    request({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10" }),
    "a-real-salt-value",
  );
  const forwardedOnly = clientKey(request({ "x-forwarded-for": "203.0.113.9" }), "a-real-salt-value");
  assert.equal(both, forwardedOnly);
});

// Every assertion above is relational — same in, same out; different in,
// different out — so all ten of them stay green if the algorithm or the
// order of concatenation changes. Measured 2026-09-20: sha256 to sha512
// with `address:salt` for `salt:address` passed 107/107, and
// `check-admission.ts` passed 17/17 too, because it derives the key it
// expects from this same function.
//
// The key is not an opaque value: it is the primary identity of a row in
// `reading.client_spend`. A formula that changes orphans every quota
// already banked and hands every device a fresh allowance, in silence.
// This pins the bytes, so changing them has to be a decision someone took
// on purpose rather than one a refactor took for them.
test("the formula itself is fixed, because banked quotas are keyed on it", () => {
  assert.equal(
    clientKeyFromAddress("203.0.113.7", "a-fixed-salt-for-this-test"),
    "694782ef69512ca7ba99a28e1e471529d5fd0a3702c18238bce72a3825b6ac31",
  );
});

test("headers alone give the key a whole request gives", () => {
  const cases: Record<string, string>[] = [
    { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    { "x-real-ip": "203.0.113.9" },
    { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10" },
    {},
  ];
  for (const headers of cases) {
    assert.equal(
      clientKeyFromHeaders(new Headers(headers), "a-real-salt-value"),
      clientKey(request(headers), "a-real-salt-value"),
    );
  }
  assert.equal(clientKeyFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.9" }), undefined), null);
});

test("each scope keys the same caller to its own row", () => {
  const key = clientKeyFromAddress("203.0.113.9", "a-real-salt-value");
  const scoped = (["text", "translate", "signin", "signin-to"] as const).map((scope) => scopeClientKey(scope, key));
  assert.equal(new Set(scoped).size, scoped.length);
  assert.ok(scoped.every((value) => value !== key));
  assert.equal(scopeClientKey("translate", key), `translate:${key}`);
});

test("no key stays no key whatever the scope", () => {
  assert.equal(scopeClientKey("text", null), null);
});

// M28: the key is the caller's network, not one address inside it.
const SALT = "a-real-salt-value";
const keyOf = (address: string) => clientKeyFromHeaders(new Headers({ "x-forwarded-for": address }), SALT);

test("two addresses inside one IPv6 /64 spend one key", () => {
  assert.ok(keyOf("2001:db8:1:2::a"));
  assert.equal(keyOf("2001:db8:1:2::a"), keyOf("2001:db8:1:2:ffff::b"));
  assert.equal(keyOf("2001:db8:1:2:1:2:3:4"), keyOf("2001:db8:1:2:ffff:ffff:ffff:ffff"));
});

test("a neighbouring /64 is another caller", () => {
  assert.notEqual(keyOf("2001:db8:1:3::a"), keyOf("2001:db8:1:2::a"));
  assert.notEqual(keyOf("2001:db8:1:2::a"), keyOf("2001:db8:2:2::a"));
});

test("an IPv6 key is the hash of its expanded /64 form", () => {
  const expected = clientKeyFromAddress("2001:0db8:0000:0000::/64", SALT);
  assert.equal(keyOf("2001:db8::1"), expected);
  assert.equal(keyOf("2001:DB8:0:0:0:0:0:1"), expected);
  assert.equal(keyOf("2001:db8:0:0::9"), expected);
});

test("a zone id does not change the IPv6 key", () => {
  assert.equal(keyOf("fe80::1%eth0"), keyOf("fe80::1"));
  assert.equal(keyOf("fe80::1%eth0"), clientKeyFromAddress("fe80:0000:0000:0000::/64", SALT));
});

test("an IPv4-mapped IPv6 address is the IPv4 caller", () => {
  assert.equal(keyOf("::ffff:203.0.113.5"), clientKeyFromAddress("203.0.113.5", SALT));
  assert.equal(keyOf("::FFFF:203.0.113.5"), keyOf("203.0.113.5"));
});

test("an unparseable value is hashed as it is", () => {
  assert.equal(keyOf("not-an-address"), clientKeyFromAddress("not-an-address", SALT));
  assert.equal(keyOf("2001:db8:::1"), clientKeyFromAddress("2001:db8:::1", SALT));
});

test("x-vercel-forwarded-for wins over x-forwarded-for and x-real-ip", () => {
  const key = clientKeyFromHeaders(
    new Headers({
      "x-vercel-forwarded-for": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1",
      "x-real-ip": "198.51.100.2",
    }),
    SALT,
  );
  assert.equal(key, clientKeyFromAddress("203.0.113.9", SALT));
});

test("x-vercel-forwarded-for takes its first entry, trimmed", () => {
  const key = clientKeyFromHeaders(
    new Headers({ "x-vercel-forwarded-for": "  203.0.113.9 , 10.0.0.1", "x-forwarded-for": "198.51.100.1" }),
    SALT,
  );
  assert.equal(key, clientKeyFromAddress("203.0.113.9", SALT));
});

test("a vercel IPv6 caller is cut to its /64 too", () => {
  const a = clientKeyFromHeaders(new Headers({ "x-vercel-forwarded-for": "2001:db8:1:2::a" }), SALT);
  const b = clientKeyFromHeaders(new Headers({ "x-vercel-forwarded-for": "2001:db8:1:2::b" }), SALT);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(a, clientKeyFromAddress("2001:0db8:0001:0002::/64", SALT));
});

test("an empty x-vercel-forwarded-for falls through to the next header", () => {
  const key = clientKeyFromHeaders(
    new Headers({ "x-vercel-forwarded-for": " ", "x-forwarded-for": "198.51.100.1" }),
    SALT,
  );
  assert.equal(key, clientKeyFromAddress("198.51.100.1", SALT));
});

test("an IPv4 caller is keyed exactly as before", () => {
  for (const address of ["198.51.100.1", "203.0.113.9", "10.0.0.1", "0.0.0.0"]) {
    assert.equal(keyOf(address), clientKeyFromAddress(address, SALT));
  }
  assert.equal(
    clientKeyFromHeaders(new Headers({ "x-real-ip": "198.51.100.1" }), SALT),
    clientKeyFromAddress("198.51.100.1", SALT),
  );
});
