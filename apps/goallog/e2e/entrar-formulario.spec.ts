import { createHash, randomBytes } from "node:crypto";

import type { Browser, Page } from "@playwright/test";
import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import account from "../messages/es/account.json";
import oauth from "../messages/es/oauth.json";
import { test, expect, type Person } from "./fixtures";
import { boxOf } from "./box";

// RP-18 and RP-60: `/entrar` and the consent signed out are one
// form, and the consent signed in is centred where `/entrar` is. Nothing here
// types an address or submits: a send reaches a real inbox (RNP-09).
const REDIRECT = "http://localhost:6274/oauth/callback";
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
const signedOut = { cookies: [], origins: [] };
const WIDTHS = [
  { width: 390, height: 800 },
  { width: 1440, height: 900 },
];

let consentPath = "";
test.beforeAll(async ({ baseURL }) => {
  const meta = await fetch(`${baseURL}/.well-known/oauth-protected-resource`);
  const { resource } = (await meta.json()) as { resource: string };
  const registered = await fetch(`${baseURL}/oauth/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify({ client_name: `Claude ${randomBytes(3).toString("hex")}`, redirect_uris: [REDIRECT] }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  await note(client_id);
  consentPath = `/oauth/autorizar?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
    code_challenge_method: "S256",
    state: "estado-381",
    resource,
  }).toString()}`;
});

async function open(
  browser: Browser,
  baseURL: string,
  size: { width: number; height: number },
  storageState: Person["sessionFile"] | typeof signedOut,
) {
  const context = await browser.newContext({
    baseURL,
    storageState,
    viewport: size,
    hasTouch: size.width < 1024,
    extraHTTPHeaders: { "x-forwarded-for": from },
  });
  return { context, page: await context.newPage() };
}

// The column's content sits as far from the top of the viewport as from the bottom.
async function expectCentred(page: Page, height: number) {
  const top = (await boxOf(page.locator("main > header")));
  const last = (await boxOf(page.locator("main > :last-child")));
  const above = top.y;
  const below = height - (last.y + last.height);
  expect(Math.abs(above - below)).toBeLessThanOrEqual(24);
  expect(above).toBeGreaterThan(40);
}

async function expectOneForm(page: Page, label: string, button: string, lead: string) {
  await expect(page.getByLabel(label)).toHaveCount(1);
  await expect(page.getByLabel(label)).not.toHaveAttribute("placeholder", /.+/);
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: button, exact: true })).toBeVisible();
  await expect(page.getByText(lead, { exact: true })).toBeVisible();
  const field = (await boxOf(page.locator("main form > div")));
  const action = (await boxOf(page.getByRole("button", { name: button, exact: true })));
  expect(Math.round(action.y - (field.y + field.height))).toBe(20);
}

for (const size of WIDTHS) {
  test(`/entrar at ${size.width}: one label, no placeholder, one button, the lead, 20 px to the button${size.width >= 1024 ? ", centred" : ""} (RP-18)`, async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, size, signedOut);
    try {
      await page.goto("/entrar");
      await expect(page.getByRole("heading", { level: 1, name: account.title, exact: true })).toBeVisible();
      await expect(page.getByText(account.eyebrow, { exact: true })).toBeVisible();
      await expectOneForm(page, account.emailLabel, account.action, account.lead);
      if (size.width >= 1024) await expectCentred(page, size.height);
    } finally {
      await context.close();
    }
  });

  test(`the consent signed out at ${size.width} is the same form under the client's title (RP-60)`, async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, size, signedOut);
    try {
      await page.goto(consentPath);
      await expect(
        page.getByRole("heading", { level: 1, name: oauth.title.replace("{client}", oauth.anonymousClient), exact: true }),
      ).toBeVisible();
      await expectOneForm(page, account.emailLabel, oauth.signedOut.send, oauth.signedOut.lead);
      if (size.width >= 1024) await expectCentred(page, size.height);
    } finally {
      await context.close();
    }
  });

  test(`the consent signed in at ${size.width} keeps its two buttons stacked${size.width >= 1024 ? " and centred like /entrar" : ""} (RP-60)`, async ({
    person,
    browser,
    baseURL,
  }) => {
    const { context, page } = await open(browser, baseURL!, size, person.sessionFile);
    try {
      await page.goto(consentPath);
      const allow = page.getByRole("button", { name: oauth.allow, exact: true });
      const deny = page.getByRole("button", { name: oauth.deny, exact: true });
      await expect(allow).toBeVisible();
      const [a, d] = [(await boxOf(allow)), (await boxOf(deny))];
      expect(d.y).toBeGreaterThanOrEqual(a.y + a.height);
      if (size.width >= 1024) await expectCentred(page, size.height);
    } finally {
      await context.close();
    }
  });
}
