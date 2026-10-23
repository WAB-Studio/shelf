import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { deliverabilityExempt, isDomainDeliverable } from "./deliverability";
import type { DnsResolvers } from "./deliverability";

// Every resolver is handed in: no test queries DNS or sends mail.

function dnsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const notFound = () => Promise.reject(dnsError("ENOTFOUND"));
const noData = () => Promise.reject(dnsError("ENODATA"));

function resolvers(overrides: Partial<DnsResolvers> = {}): DnsResolvers {
  return { resolveMx: notFound, resolve4: notFound, resolve6: notFound, ...overrides };
}

// Mutation: drop isNullMx.
test("a single null MX reads as undeliverable", async () => {
  const result = await isDomainDeliverable("example.com", resolvers({ resolveMx: async () => [{ exchange: ".", priority: 0 }] }));
  assert.equal(result, false);
});

// Mutation: read ENODATA as a failure.
test("no MX and no A/AAAA record reads as undeliverable", async () => {
  const result = await isDomainDeliverable("example.com", resolvers({ resolveMx: noData, resolve4: noData, resolve6: noData }));
  assert.equal(result, false);
});

// Mutation: return false when the MX list is empty.
test("no MX but an A record reads as deliverable (implicit MX)", async () => {
  const result = await isDomainDeliverable("example.com", resolvers({ resolveMx: noData, resolve4: async () => ["192.0.2.1"] }));
  assert.equal(result, true);
});

// Mutation: treat every error as "none".
test("a resolver that throws ESERVFAIL reads as deliverable", async () => {
  const result = await isDomainDeliverable("example.com", resolvers({ resolveMx: () => Promise.reject(dnsError("ESERVFAIL")) }));
  assert.equal(result, true);
});

// Mutation: drop the timeout race.
test("a resolver that hangs reads as deliverable once the 2.5s budget passes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hangs = new Promise<never>(() => {});
    const pending = isDomainDeliverable("example.com", resolvers({ resolveMx: () => hangs }));
    mock.timers.tick(2_500);
    assert.equal(await pending, true);
  } finally {
    mock.timers.reset();
  }
});

// Mutation: drop the host test, or exempt every domain locally.
test(".invalid is exempt on the local stack alone", () => {
  assert.equal(deliverabilityExempt("x.invalid", "http://127.0.0.1:44321"), true);
  assert.equal(deliverabilityExempt("x.invalid", "http://localhost:44321"), true);
  assert.equal(deliverabilityExempt("x.invalid", "https://abc.supabase.co"), false);
  assert.equal(deliverabilityExempt("gmail.com", "http://127.0.0.1:44321"), false);
});

// Mutation: exempt any domain containing "invalid" instead of the `.invalid` suffix.
test("a real-looking domain that merely contains «invalid» is not exempt, even locally", () => {
  assert.equal(deliverabilityExempt("invalidmail.com", "http://127.0.0.1:44321"), false);
  assert.equal(deliverabilityExempt("invalid.com", "http://localhost:44321"), false);
  assert.equal(deliverabilityExempt("mail.invalid.org", "http://127.0.0.1:44321"), false);
});

// Mutation: the null-MX test reads `records.length >= 1`.
test("a null MX beside a real MX is deliverable", async () => {
  const result = await isDomainDeliverable(
    "example.com",
    resolvers({
      resolveMx: async () => [
        { exchange: ".", priority: 0 },
        { exchange: "mx.real.", priority: 10 },
      ],
    }),
  );
  assert.equal(result, true);
});
