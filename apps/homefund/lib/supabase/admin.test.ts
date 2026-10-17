import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// RF-148. `createSupabaseAdminClient` answers null without the secret key and a client with it.
// The env is doubled at module resolution.

const state: { key?: string } = {};
(globalThis as unknown as { __adminEnv: typeof state }).__adminEnv = state;

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/lib/env": `export const env = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
    NEXT_PUBLIC_SITE_URL: "http://site.invalid",
    get SUPABASE_SECRET_KEY() { return globalThis.__adminEnv.key; },
  };`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) {
      return { format: "module", source: DOUBLES[url.slice("double:".length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// Mutation: build the client from the publishable key when the secret is missing.
test("without the secret key there is no admin client", async () => {
  state.key = undefined;
  const { createSupabaseAdminClient } = await import("./admin");
  assert.equal(createSupabaseAdminClient(), null);
});

// Mutation: return null always.
test("with the secret key the client exposes Auth's admin API", async () => {
  state.key = "sb_secret_test";
  const { createSupabaseAdminClient } = await import("./admin");
  const client = createSupabaseAdminClient();
  assert.ok(client);
  assert.equal(typeof client.auth.admin.inviteUserByEmail, "function");
});
