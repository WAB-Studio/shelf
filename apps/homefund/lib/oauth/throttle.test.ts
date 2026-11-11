import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

// Only the database is doubled; its answer is what `private.claim_oauth_call` returns (0 admitted, else seconds).
let wait = 0;
(globalThis as unknown as { __throttleDouble: unknown }).__throttleDouble = {
  execute: async () => [{ wait }],
};
const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/db/client": "export const db = globalThis.__throttleDouble;",
  "@/db/queries/webhook-credentials": "export const CLAUDE_KEY_RATE_LIMIT_PER_MIN = 600;",
  "@/db/session": "export const withUserDb = (fn) => fn(globalThis.__throttleDouble);",
  "@/lib/mcp/server": "export const ISSUER = \"https://x.test\";",
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

beforeEach(() => {
  wait = 0;
});

const register = async () => {
  const { POST } = await import("../../app/oauth/register/route");
  return POST(
    new Request("https://x.test/oauth/register", {
      method: "POST",
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    }),
  );
};

test("the caller address is the first forwarded hop, or one shared unknown", async () => {
  const { callerAddress } = await import("./throttle");
  const of = (value: string | null) => callerAddress({ headers: new Headers(value ? { "x-forwarded-for": value } : {}) });
  assert.equal(of("203.0.113.7, 10.0.0.1"), "203.0.113.7");
  assert.equal(of(null), "unknown");
});

test("a registration over the cap is a 429 with Retry-After, and registers nothing", async () => {
  wait = 1800;
  const response = await register();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1800");
  assert.deepEqual(await response.json(), { error: "too_many_requests" });
});
