import { createHash, randomBytes } from "node:crypto";

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import account from "../messages/es/account.json";
import connections from "../messages/es/connections.json";
import oauth from "../messages/es/oauth.json";
import { test, expect, type Person } from "./fixtures";
import { boxOf } from "./box";

// RP-60, RNP-01, RNP-07: the consent screen. The person is signed in through
// the fixture's session, never the form; a client registers itself through
// `/oauth/registro` as claude.ai does. The client's own redirect is a route
// the spec answers itself, so nothing leaves the machine. The sign-in form is
// asserted present and carrying `next`, never submitted: a send reaches a real
// inbox.
const REDIRECT = "http://localhost:6274/oauth/callback";
const STATE = "estado-de-prueba-123";
// A /64 of the documentation prefix, new per worker: the spec's calls to the
// throttled routes never share a counter with another lane, file or run.
// HARNESS_RUN_ID reaches this process, not the server: the spec notes its own client.
async function note(clientId: string): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await registerOAuthClient(sql, clientId);
  } finally {
    await sql.end();
  }
}

const from = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
const asRun = { "x-forwarded-for": from };
const signedOut = { cookies: [], origins: [] };

const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (value: string) => createHash("sha256").update(value).digest("base64url");

async function register(baseURL: string, name: string, redirect = REDIRECT): Promise<string> {
  const response = await fetch(`${baseURL}/oauth/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...asRun },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }),
  });
  expect(response.status).toBe(201);
  const { client_id } = (await response.json()) as { client_id: string };
  await note(client_id);
  return client_id;
}

// The audience a real client reads from the server's own metadata, never one it builds.
let resource = "";
// One registration per worker: `/oauth/registro` is throttled per address (RNP-19).
let client = { id: "", name: "" };
test.beforeAll(async ({ baseURL }) => {
  const response = await fetch(`${baseURL}/.well-known/oauth-protected-resource`);
  expect(response.status).toBe(200);
  resource = ((await response.json()) as { resource: string }).resource;
  expect(resource).toMatch(/\/mcp$/);
  const name = `Claude ${randomBytes(3).toString("hex")}`;
  client = { id: await register(baseURL!, name), name };
});

function consentPath(clientId: string, challenge: string, redirect = REDIRECT): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: STATE,
    resource,
  });
  return `/oauth/autorizar?${params.toString()}`;
}

async function open(
  browser: Browser,
  baseURL: string,
  storageState: Person["sessionFile"] | typeof signedOut,
  width = 360,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState,
    baseURL,
    viewport: { width, height: 740 },
    hasTouch: width < 1024,
    extraHTTPHeaders: asRun,
  });
  const page = await context.newPage();
  // The client's own address: answered here, never reached.
  await page.route("http://localhost:6274/**", (route) => route.fulfill({ status: 200, body: "ok" }));
  return { context, page };
}

async function expectNoOverflow(page: Page) {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll).toBeLessThanOrEqual(inner);
}

test.describe("the consent screen (RP-60)", () => {
  test("signed in it names the client, lists what it may and never may, and fits 360", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { id: clientId, name } = client;
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await page.goto(consentPath(clientId, challengeOf(verifier())));
      await expect(page.getByRole("heading", { level: 1, name: oauth.title.replace("{client}", name) })).toBeVisible();
      for (const text of [...Object.values(oauth.may), ...Object.values(oauth.never)]) {
        await expect(page.getByText(text, { exact: true })).toBeVisible();
      }
      await expect(page.getByRole("button", { name: oauth.allow, exact: true })).toBeVisible();
      // Literal: the lead no longer sends the person to a second place to revoke (PermisoPalabras).
      await expect(page.getByText("Podrá leer tus metas y anotar lo que hagas.", { exact: true })).toBeVisible();
      // 318: the app has one name wherever a person reads it.
      await expect(page.getByText(oauth.eyebrow, { exact: true })).toBeVisible();
      expect(await page.locator("main").innerText()).not.toMatch(/pulsar ·/i);
      await expect(page.getByRole("button", { name: oauth.deny })).toBeVisible();
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expectNoOverflow(page);
    } finally {
      await context.close();
    }
  });

  test("«Permitir» lands on the client's redirect with a code and the same state, and /conexiones lists it", async ({
    person,
    browser,
    baseURL,
  }) => {
    const { id: clientId, name } = client;
    const secret = verifier();
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await page.goto(consentPath(clientId, challengeOf(secret)));
      await page.getByRole("button", { name: oauth.allow, exact: true }).click();
      await page.waitForURL(/localhost:6274/);

      const back = new URL(page.url());
      expect(back.origin + back.pathname).toBe(REDIRECT);
      expect(back.searchParams.get("state")).toBe(STATE);
      const code = back.searchParams.get("code");
      expect(code).toMatch(/^plc_/);
      expect(back.searchParams.get("error")).toBeNull();

      // The connection exists once the client exchanges the code for its tokens.
      const exchanged = await fetch(`${baseURL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...asRun },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: secret,
          client_id: clientId,
          redirect_uri: REDIRECT,
        }),
      });
      expect(exchanged.status).toBe(200);

      await page.goto("/conexiones");
      await expect(page.getByText(connections.sections.oauth, { exact: true })).toBeVisible();
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("«No permitir» lands on the client's redirect with access_denied, the state and no code", async ({
    person,
    browser,
    baseURL,
  }) => {
    const clientId = client.id;
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await page.goto(consentPath(clientId, challengeOf(verifier())));
      await page.getByRole("button", { name: oauth.deny }).click();
      await page.waitForURL(/localhost:6274/);

      const back = new URL(page.url());
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("state")).toBe(STATE);
      expect(back.searchParams.get("code")).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("a redirect the client did not register reads as invalid and offers nothing to approve", async ({
    person,
    browser,
    baseURL,
  }) => {
    const clientId = client.id;
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      await page.goto(consentPath(clientId, challengeOf(verifier()), "http://localhost:6274/otra"));
      await expect(page.getByRole("heading", { level: 1, name: oauth.invalid.title })).toBeVisible();
      await expect(page.getByText(oauth.invalid.body, { exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("link", { name: oauth.invalid.home })).toHaveAttribute("href", "/");
      await expectNoOverflow(page);
    } finally {
      await context.close();
    }
  });

  test("a request with no PKCE challenge reads as invalid", async ({ person, browser, baseURL }) => {
    const clientId = client.id;
    const { context, page } = await open(browser, baseURL!, person.sessionFile);
    try {
      const path = consentPath(clientId, challengeOf(verifier())).replace(/&code_challenge=[^&]*/, "");
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: oauth.invalid.title })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("signed out it asks for the address in the shared form under the client's title", async ({
    browser,
    baseURL,
  }) => {
    const { id: clientId } = client;
    const path = consentPath(clientId, challengeOf(verifier()));
    const { context, page } = await open(browser, baseURL!, signedOut);
    try {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: oauth.title.replace("{client}", oauth.anonymousClient) }),
      ).toBeVisible();
      await expect(page.getByLabel(account.emailLabel)).not.toHaveAttribute("placeholder", /.+/);
      await expect(page.getByRole("button", { name: oauth.signedOut.send })).toBeVisible();
      await expect(page.getByText(oauth.signedOut.lead, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: oauth.allow, exact: true })).toHaveCount(0);
      await expectNoOverflow(page);
    } finally {
      await context.close();
    }
  });

  test("at 1280 the column stands alone and centred, with no overflow", async ({ person, browser, baseURL }) => {
    const clientId = client.id;
    const { context, page } = await open(browser, baseURL!, person.sessionFile, 1280);
    try {
      await page.goto(consentPath(clientId, challengeOf(verifier())));
      const button = page.getByRole("button", { name: oauth.allow, exact: true });
      await expect(button).toBeVisible();
      await expectNoOverflow(page);
      // 640px column centred in 1280: its left edge is 320px, never the rail's.
      const box = (await boxOf(page.getByRole("main")));
      expect(Math.abs(box.x - 320)).toBeLessThanOrEqual(1);
      expect(box.width).toBeLessThanOrEqual(640);
    } finally {
      await context.close();
    }
  });
});
