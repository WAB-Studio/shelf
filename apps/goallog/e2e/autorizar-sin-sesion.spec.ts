import { randomBytes, randomUUID } from "node:crypto";
import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import oauth from "../messages/es/oauth.json";
import { test, expect } from "./fixtures";

// RP-60, RNP-09: the consent screen without a session, and with a client that
// does not exist. The sign-in form is never submitted and no address is typed:
// a send reaches a real inbox. The `next` the form would send is a prop of a
// client component, so the spec reads it from the flight payload the document carries.
const REDIRECT = "http://localhost:6274/oauth/callback";
const STATE = "estado-de-prueba-123";
// HARNESS_RUN_ID reaches this process, not the server: the spec notes its own client.
async function note(clientId: string): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await registerOAuthClient(sql, clientId);
  } finally {
    await sql.end();
  }
}

// A /64 of the documentation prefix, new per worker, so the throttled
// `/oauth/registro` never shares a counter with another lane, file or run.
const from = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
const asRun = { "x-forwarded-for": from };

// The audience a real client reads from the server's own metadata.
let resource = "";
test.beforeAll(async ({ baseURL }) => {
  const response = await fetch(`${baseURL}/.well-known/oauth-protected-resource`);
  expect(response.status).toBe(200);
  resource = ((await response.json()) as { resource: string }).resource;
});

function requestPath(clientId: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: randomBytes(32).toString("base64url"),
    code_challenge_method: "S256",
    state: STATE,
    resource,
  });
  return `/oauth/autorizar?${params.toString()}`;
}

test.describe("the consent screen without a session (RP-60)", () => {
  test("the sign-in form brings the person back to the very request that brought them", async ({
    browser,
    baseURL,
  }) => {
    const registered = await fetch(`${baseURL}/oauth/registro`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asRun },
      body: JSON.stringify({ client_name: `Claude ${randomBytes(3).toString("hex")}`, redirect_uris: [REDIRECT] }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    await note(client_id);
    const path = requestPath(client_id);

    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      const response = await page.goto(path);
      await expect(page.getByRole("button", { name: oauth.signedOut.send })).toBeVisible();

      const flight = await response!.text();
      const raw = /"next\\":\\"(\/oauth(?:[^"\\]|\\u[0-9a-f]{4})*)/.exec(flight)?.[1];
      expect(raw, `the form's next prop is in the page, starting at the request; got ${JSON.stringify(raw)} in ${flight.slice(0, 200)}`).toMatch(/^\/oauth\/autorizar\?/);
      const next = JSON.parse(`"${raw}"`) as string;
      expect(next.startsWith("/oauth/autorizar?")).toBe(true);
      const params = new URL(next, baseURL!).searchParams;
      expect(params.get("client_id")).toBe(client_id);
      expect(params.get("state")).toBe(STATE);
      expect(next).toBe(path);
    } finally {
      await context.close();
    }
  });

  test("a client that does not exist reads as invalid, not as an error page", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      const response = await page.goto(requestPath(randomUUID()));
      expect(response!.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: oauth.invalid.title })).toBeVisible();
      await expect(page.getByText(oauth.invalid.body, { exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
