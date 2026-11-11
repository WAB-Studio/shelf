import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

// Only the database is doubled: the real `exchangeCode` decides what reaches it. The code's expiry, its
// single use and the client and redirect it is bound to are the SQL function's, driven in `check-rls`.
let statements = 0;
let owner: string | null;
(globalThis as unknown as { __grantsDouble: unknown }).__grantsDouble = {
  execute: async () => {
    statements += 1;
    return [{ owner }];
  },
};
const D = "globalThis.__grantsDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/db/client": `export const db = ${D};`,
  "@/db/queries/webhook-credentials": "export const CLAUDE_KEY_RATE_LIMIT_PER_MIN = 600;",
  "@/db/session": `export const withUserDb = (fn) => fn(${D});`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) return { format: "module", source: DOUBLES[url.slice(7)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const input = {
  code: "hfc_x",
  verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  clientId: "0b9b3a52-6a8e-4f0e-9c58-5f4a5b6a8f10",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
};

beforeEach(() => {
  statements = 0;
  owner = "user-1";
});

test("a verifier PKCE refuses never reaches the database", async () => {
  const { exchangeCode } = await import("./grants");
  assert.equal(await exchangeCode({ ...input, verifier: "short" }), null);
  assert.equal(await exchangeCode({ ...input, verifier: "bad chars ".repeat(6) }), null);
  assert.equal(statements, 0);
});

test("a code the function redeems answers a whk_ bearer, in one statement", async () => {
  const { exchangeCode } = await import("./grants");
  const token = await exchangeCode(input);
  assert.match(token ?? "", /^whk_[A-Za-z0-9_-]{43}$/);
  assert.equal(statements, 1);
});

test("a code the function refuses (wrong verifier, expired, reused) answers no bearer", async () => {
  const { exchangeCode } = await import("./grants");
  owner = null;
  assert.equal(await exchangeCode(input), null);
  assert.equal(statements, 1);
});

test("each exchange mints its own bearer", async () => {
  const { exchangeCode } = await import("./grants");
  const [a, b] = [await exchangeCode(input), await exchangeCode(input)];
  assert.notEqual(a, b);
  assert.notEqual(createHash("sha256").update(a ?? "").digest("hex"), createHash("sha256").update(b ?? "").digest("hex"));
});
