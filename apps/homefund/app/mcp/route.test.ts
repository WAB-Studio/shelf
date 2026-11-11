import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

// The real route and the real `withMcpAuth` run; the credential resolver and the MCP handler are doubled.
// A key minted by hand and a key an OAuth code bought are the same row, so one resolver answer stands for both.
let credential: { credentialId: string; ownerUserId: string; throttled: boolean } | null;
(globalThis as unknown as { __mcpDouble: unknown }).__mcpDouble = { resolve: async () => credential };
const D = "globalThis.__mcpDouble";

const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/db/queries/webhook-credentials": `export const resolveWebhookCredential = (...a) => ${D}.resolve(...a);`,
  "@/lib/mcp/server": `export const ISSUER = "https://homefund.test";
    export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
    export const buildHandler = () => async () => new Response("served");`,
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

const call = (headers: Record<string, string> = {}, host = "homefund.test") =>
  import("./route").then(({ GET }) => GET(new Request(`https://${host}/mcp`, { headers: { host, ...headers } })));

beforeEach(() => {
  credential = null;
});

test("no bearer is a 401 that names the resource metadata, so claude.ai starts its OAuth flow", async () => {
  const response = await call();
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer error="invalid_token", error_description="No authorization provided", resource_metadata="https://homefund.test/.well-known/oauth-protected-resource/mcp"',
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the 401 names the metadata of the served host the request came on, and falls back to the configured one", async () => {
  const old = await call({}, "our-piggy-bank.vercel.app");
  assert.match(old.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/our-piggy-bank\.vercel\.app\/\.well-known\/oauth-protected-resource\/mcp"/);
  const stranger = await call({}, "evil.example");
  assert.match(stranger.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/homefund\.test\//);
});

test("an unknown or revoked bearer is the same 401", async () => {
  const response = await call({ authorization: "Bearer whk_unknown" });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/homefund\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("a live key opens the door, however it was minted", async () => {
  credential = { credentialId: "c1", ownerUserId: "u1", throttled: false };
  const response = await call({ authorization: "Bearer whk_live" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "served");
});

test("a live key over its window is a 429, not a 401", async () => {
  credential = { credentialId: "c1", ownerUserId: "u1", throttled: true };
  assert.equal((await call({ authorization: "Bearer whk_live" })).status, 429);
});
