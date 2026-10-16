import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

// A trailing slash, and two, on purpose: the issuer never keeps them.
mock.module("@/lib/env", { namedExports: { env: { NEXT_PUBLIC_SITE_URL: "https://pulsar.test//" } } });
mock.module("@/lib/mcp/tools/read", { namedExports: { registerReadTools: () => {} } });
mock.module("@/lib/mcp/tools/write", { namedExports: { registerWriteTools: () => {} } });
mock.module("@/db/client", { namedExports: { db: { execute: async () => [{ wait: 0 }] } } });
mock.module("@/lib/oauth/grants", { namedExports: { registerClient: async () => "id-1" } });

let server: typeof import("@/app/.well-known/oauth-authorization-server/route");
let resource: typeof import("@/lib/mcp/server");
let resourceRoute: typeof import("@/app/.well-known/oauth-protected-resource/route");
let resourceMcpRoute: typeof import("@/app/.well-known/oauth-protected-resource/mcp/route");
let registro: typeof import("@/app/oauth/registro/route");

before(async () => {
  server = await import("@/app/.well-known/oauth-authorization-server/route");
  resource = await import("@/lib/mcp/server");
  resourceRoute = await import("@/app/.well-known/oauth-protected-resource/route");
  resourceMcpRoute = await import("@/app/.well-known/oauth-protected-resource/mcp/route");
  registro = await import("@/app/oauth/registro/route");
});

function assertPreflight(response: Response, methods: string): void {
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-methods"), methods);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
}

test("the authorization server document strips every trailing slash from the issuer", async () => {
  const response = server.GET();
  const document = await response.json();
  assert.equal(document.issuer, "https://pulsar.test");
  assert.equal(document.authorization_endpoint, "https://pulsar.test/oauth/autorizar");
  assert.equal(document.token_endpoint, "https://pulsar.test/oauth/token");
  assert.equal(document.registration_endpoint, "https://pulsar.test/oauth/registro");
  assert.equal(response.headers.get("cache-control"), "max-age=3600");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("the resource document names the stripped origin, and its URL is built on it", async () => {
  assert.equal(resource.SITE_URL, "https://pulsar.test");
  assert.equal(resource.MCP_URL, "https://pulsar.test/mcp");
  for (const response of [resourceRoute.GET(), resourceMcpRoute.GET()]) {
    const document = await response.json();
    assert.deepEqual(document.authorization_servers, ["https://pulsar.test"]);
    assert.equal(document.resource, "https://pulsar.test/mcp");
    assert.equal(response.headers.get("cache-control"), "max-age=3600");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
});

test("each discovery preflight is 204, any origin, GET, no credentials", () => {
  assertPreflight(server.OPTIONS(), "GET, OPTIONS");
  assertPreflight(resourceRoute.OPTIONS(), "GET, OPTIONS");
  assertPreflight(resourceMcpRoute.OPTIONS(), "GET, OPTIONS");
});

test("the registration preflight is 204, any origin, POST, no credentials", () => {
  assertPreflight(registro.OPTIONS(), "POST, OPTIONS");
});

test("registration answers the whole public-client document", async () => {
  const uris = ["http://localhost:6274/oauth/callback"];
  const response = await registro.POST(
    new Request("http://x.test/oauth/registro", {
      method: "POST",
      body: JSON.stringify({ client_name: "flow", redirect_uris: uris }),
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), {
    client_id: "id-1",
    client_name: "flow",
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});
