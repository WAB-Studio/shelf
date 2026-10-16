// RL-22: a domain that can take mail is never refused, and a lookup that
// itself breaks never counts against the reader. Resolvers are handed in, so
// no DNS is queried and no Supabase client or mail is reached.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/navigation") return { url: "double:nav", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "double:nav") return { format: "module", source: "export const redirect = () => undefined;", shortCircuit: true };
    return nextLoad(url, context);
  },
});

type Mx = { exchange: string; priority: number }[];
const err = (code: string) => Object.assign(new Error(code), { code });
const fail = (code: string) => () => Promise.reject(err(code));
const answer = <T>(value: T) => () => Promise.resolve(value);

function resolvers(over: { mx?: () => Promise<Mx>; a?: () => Promise<string[]>; aaaa?: () => Promise<string[]> }) {
  return {
    resolveMx: over.mx ?? fail("ENODATA"),
    resolve4: over.a ?? fail("ENODATA"),
    resolve6: over.aaaa ?? fail("ENODATA"),
  };
}

async function deliverable(over: Parameters<typeof resolvers>[0]) {
  const { isDomainDeliverable } = await import("../../app/actions/account");
  return isDomainDeliverable("reader.test", resolvers(over));
}

test("a resolver that breaks on MX (not ENOTFOUND/ENODATA) is not held against the domain", async () => {
  for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"]) {
    assert.equal(await deliverable({ mx: fail(code) }), true, code);
  }
});

test("no MX and an A record: deliverable by the implicit MX", async () => {
  assert.equal(await deliverable({ a: answer(["192.0.2.1"]) }), true);
});

test("no MX, no A, an AAAA record: deliverable", async () => {
  assert.equal(await deliverable({ aaaa: answer(["2001:db8::1"]) }), true);
});

test("no MX and an A lookup that breaks: deliverable", async () => {
  assert.equal(await deliverable({ a: fail("ETIMEOUT") }), true);
});

test("no MX, no A and an AAAA lookup that breaks: deliverable", async () => {
  assert.equal(await deliverable({ aaaa: fail("ESERVFAIL") }), true);
});

test("no MX, no A, no AAAA: undeliverable", async () => {
  assert.equal(await deliverable({}), false);
  assert.equal(await deliverable({ a: answer([]), aaaa: answer([]) }), false);
});

test("a lone null MX is undeliverable", async () => {
  assert.equal(await deliverable({ mx: answer([{ exchange: ".", priority: 0 }]) }), false);
});

test("a null MX beside a real MX is deliverable", async () => {
  const mx = answer([
    { exchange: ".", priority: 0 },
    { exchange: "mx.live.test", priority: 10 },
  ]);
  assert.equal(await deliverable({ mx }), true);
});
