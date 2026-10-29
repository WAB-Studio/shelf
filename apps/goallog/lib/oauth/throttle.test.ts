import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

// `@/db/client` imports `server-only`, which throws outside Next.
mock.module("@/db/client", { namedExports: { db: {} } });

let callerAddress: typeof import("./throttle").callerAddress;
let LIMITS: typeof import("./throttle").LIMITS;
let tooMany: typeof import("./throttle").tooMany;

before(async () => {
  ({ callerAddress, tooMany, LIMITS } = await import("./throttle"));
});

const from = (forwarded?: string) =>
  new Request("http://x.test/", forwarded === undefined ? {} : { headers: { "x-forwarded-for": forwarded } });

test("the first value of the list is the caller, an IPv4 address kept whole", () => {
  assert.equal(callerAddress(from("203.0.113.7, 10.0.0.1")), "203.0.113.7");
});

test("two addresses in one /64 give one key, another /64 gives another", () => {
  const a = callerAddress(from("2001:db8:1:2::1"));
  assert.equal(callerAddress(from("2001:db8:1:2:aaaa:bbbb:cccc:dddd")), a);
  assert.notEqual(callerAddress(from("2001:db8:1:3::1")), a);
});

test("a missing header and a value that is no address give unknown", () => {
  assert.equal(callerAddress(from()), "unknown");
  assert.equal(callerAddress(from("not-an-ip")), "unknown");
  assert.equal(callerAddress(from("999.1.1.1")), "unknown");
  assert.equal(callerAddress(from("")), "unknown");
});

test("the refusal is a 429 with the wait, the route's CORS and no caching", async () => {
  const response = tooMany(42, { "Access-Control-Allow-Origin": "*" });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-expose-headers"), "Retry-After");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "too_many_requests" });
});

test("the whitespace around the first value is trimmed", () => {
  assert.equal(callerAddress(from("203.0.113.7 , 10.0.0.1")), "203.0.113.7");
  assert.equal(callerAddress(from("  203.0.113.7")), "203.0.113.7");
});

test("an IPv4 octet above 255 is no address", () => {
  assert.equal(callerAddress(from("1.1.1.256")), "unknown");
  assert.equal(callerAddress(from("1.1.1.255")), "1.1.1.255");
});

test("a malformed IPv6 literal is unknown and a zone id is dropped before the /64", () => {
  for (const bad of ["1::2::3", "1:2:3:4:5:6:7::8", "2001:db8::fffff", "1:2:3:4:5:6:7"]) {
    assert.equal(callerAddress(from(bad)), "unknown", bad);
  }
  assert.equal(callerAddress(from("fe80::1%eth0")), callerAddress(from("fe80::2")));
  assert.equal(callerAddress(from("fe80::1%eth0")), "fe80:0:0:0::/64");
  assert.equal(callerAddress(from("2001:db8:1:2:3:4:5:6")), "2001:db8:1:2::/64");
});

test("the limits are ten registrations an hour and thirty token requests in five minutes", () => {
  assert.deepEqual(LIMITS, {
    register: { cap: 10, windowSeconds: 3600 },
    token: { cap: 30, windowSeconds: 300 },
  });
});

test("on Vercel the address is the platform's header, never the client's", () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const request = new Request("http://x.test/", {
      headers: { "x-forwarded-for": "1.1.1.1", "x-vercel-forwarded-for": "2.2.2.2" },
    });
    assert.equal(callerAddress(request), "2.2.2.2");
    assert.equal(callerAddress(from("1.1.1.1")), "unknown");
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});
