import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { isDomainDeliverable } from "./deliverability";
import type { DnsResolvers } from "./deliverability";

// Every test hands `isDomainDeliverable` its own resolvers — never the real
// `node:dns/promises` — and never touches `sendSignInLink` or the sign-in
// form, so no test here ever sends mail or mints an `auth.users` row.

function dnsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function notFound(): Promise<never> {
  return Promise.reject(dnsError("ENOTFOUND"));
}

function resolvers(overrides: Partial<DnsResolvers> = {}): DnsResolvers {
  return {
    resolveMx: notFound,
    resolve4: notFound,
    resolve6: notFound,
    ...overrides,
  };
}

test("a single null MX (RFC 7505) reads as undeliverable", async () => {
  const result = await isDomainDeliverable(
    "example.com",
    resolvers({ resolveMx: async () => [{ exchange: ".", priority: 0 }] }),
  );
  assert.equal(result, false);
});

test("ENOTFOUND on the MX lookup and on both address records reads as undeliverable", async () => {
  const result = await isDomainDeliverable("example.com", resolvers());
  assert.equal(result, false);
});

test("ETIMEOUT on the MX lookup reads as deliverable — the resolver failed, not the domain", async () => {
  const result = await isDomainDeliverable(
    "example.com",
    resolvers({ resolveMx: () => Promise.reject(dnsError("ETIMEOUT")) }),
  );
  assert.equal(result, true);
});

test("a lookup that hangs past the 2.5s budget reads as deliverable", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hangs = new Promise<never>(() => {
      // never settles: the resolver is stuck, not answering "no".
    });
    const pending = isDomainDeliverable("example.com", resolvers({ resolveMx: () => hangs }));
    mock.timers.tick(2_500);
    assert.equal(await pending, true);
  } finally {
    mock.timers.reset();
  }
});

test("a real MX reads as deliverable", async () => {
  const result = await isDomainDeliverable(
    "example.com",
    resolvers({ resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }] }),
  );
  assert.equal(result, true);
});
