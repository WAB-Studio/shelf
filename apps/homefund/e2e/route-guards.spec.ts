/**
 * The two download routes answer a caller with no session, or with a cookie the
 * auth server never signed, with the login redirect and no workbook (RF-118,
 * RF-49). The proxy is an optimistic gate that reads the cookie and nothing
 * else; the routes carry `requireUser()` of their own (RNF-04).
 *
 * What this cannot see: a route that loses its own `requireUser()` while the
 * proxy stays. Both read the same verified claims, so no cookie passes one and
 * fails the other, and `withUserDb` throws before any row is read. The routes'
 * own guard is unobservable over the wire; this spec holds the two layers
 * together, so a download that reaches an unsigned caller fails here.
 */
import { expect } from "@playwright/test";

import { test } from "./global-setup";

const SPREADSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ROUTES = ["/es/settings/data/export", "/es/settings/data/template"];

// The cookie `@supabase/ssr` reads, named after the project's first hostname label.
const COOKIE = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0]}-auth-token`;

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// A session in the shape the client stores, over a token no key ever signed.
function forgedSession(): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = [
    base64url({ alg: "HS256", typ: "JWT" }),
    base64url({
      sub: "00000000-0000-0000-0000-000000000001",
      email: "forged@example.invalid",
      role: "authenticated",
      aud: "authenticated",
      exp,
      session_id: "00000000-0000-0000-0000-000000000002",
    }),
    "AAAA",
  ].join(".");
  const session = {
    access_token: token,
    refresh_token: "forged",
    expires_in: 3600,
    expires_at: exp,
    token_type: "bearer",
    user: { id: "00000000-0000-0000-0000-000000000001", email: "forged@example.invalid" },
  };

  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
}

test.use({ storageState: { cookies: [], origins: [] } });

for (const route of ROUTES) {
  test(`${route} sends a caller with no session to the login and hands over no workbook`, async ({ request }) => {
    // Kills: the proxy and the route both dropping their session check (an unsigned caller downloads the workbook).
    const response = await request.get(route, { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location, response.url()).pathname).toBe("/es/login");
    expect(response.headers()["content-type"] ?? "").not.toContain(SPREADSHEET);
  });

  test(`${route} refuses a forged session cookie and hands over no workbook`, async ({ request }) => {
    // Kills: a cookie that is merely well formed being taken for a session (a forged one downloads the workbook).
    const response = await request.get(route, {
      maxRedirects: 0,
      headers: { cookie: `${COOKIE}=${forgedSession()}` },
    });

    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location, response.url()).pathname).toBe("/es/login");
    expect(response.headers()["content-type"] ?? "").not.toContain(SPREADSHEET);
    expect((await response.body()).length).toBeLessThan(1024);
  });
}
