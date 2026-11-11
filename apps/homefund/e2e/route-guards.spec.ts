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

test.use({ storageState: { cookies: [], origins: [] } });

for (const route of ROUTES) {
  test(`${route} sends a caller with no session to the login and hands over no workbook`, async ({ request }) => {
    // Kills: the proxy and the route both dropping their session check (an unsigned caller downloads the workbook).
    const response = await request.get(route, { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location, response.url()).pathname).toBe("/es/login");
    expect(response.headers()["content-type"] ?? "").not.toContain(SPREADSHEET);
  });
}
