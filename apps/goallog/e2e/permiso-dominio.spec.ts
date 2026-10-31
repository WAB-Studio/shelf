import { createHash, randomBytes } from "node:crypto";

import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import oauth from "../messages/es/oauth.json";
import { test, expect, appAlerts, type Person } from "./fixtures";
import { boxOf } from "./box";

// RP-60: the signed-in consent line names where the person returns, «al permitir,
// vuelves a <host>». The words are written here, not read from `oauth.json`:
// the spec owes the person this sentence whatever key carries it.
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const LOCAL = "http://localhost:33418/callback";
const LONG_HOST = `${"a".repeat(63)}.example`;
const LONG = `https://${LONG_HOST}/cb`;
const UNREGISTERED = "https://claude.ai/otro";
const STATE = "estado-de-prueba-123";
const LEAD = "al permitir, vuelves a";

// HARNESS_RUN_ID reaches this process, not the server: the spec notes its own client.
async function note(clientId: string): Promise<void> {
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await registerOAuthClient(sql, clientId);
  } finally {
    await sql.end();
  }
}

const from = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::2`;
const asRun = { "x-forwarded-for": from };
const signedOut = { cookies: [], origins: [] };

const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (value: string) => createHash("sha256").update(value).digest("base64url");

let resource = "";
let clientId = "";
// `/oauth/registro` is throttled per address: one registration carries all three returns.
test.beforeAll(async ({ baseURL }) => {
  const meta = await fetch(`${baseURL}/.well-known/oauth-protected-resource`);
  expect(meta.status).toBe(200);
  resource = ((await meta.json()) as { resource: string }).resource;
  const response = await fetch(`${baseURL}/oauth/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...asRun },
    body: JSON.stringify({
      client_name: `Claude ${randomBytes(3).toString("hex")}`,
      redirect_uris: [CLAUDE, LOCAL, LONG],
    }),
  });
  expect(response.status).toBe(201);
  clientId = ((await response.json()) as { client_id: string }).client_id;
  await note(clientId);
});

function consentPath(redirect: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challengeOf(verifier()),
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
  width: number,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState,
    baseURL,
    viewport: { width, height: 800 },
    hasTouch: width < 1024,
    extraHTTPHeaders: asRun,
  });
  return { context, page: await context.newPage() };
}

const lineOf = (page: Page): Locator => page.locator("main p").filter({ hasText: LEAD });

async function noOverflow(page: Page, width: number) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(width);
}

for (const width of [390, 1280]) {
  test.describe(`PermisoDominio at ${width}`, () => {
    test("claude.ai: the line names the host and never the path", async ({ person, browser, baseURL }) => {
      const { context, page } = await open(browser, baseURL!, person.sessionFile, width);
      try {
        await page.goto(consentPath(CLAUDE));
        const line = lineOf(page);
        await expect(line).toHaveCount(1);
        await expect(line).toHaveText(`${LEAD} claude.ai`);
        await expect(line.locator("strong")).toHaveText("claude.ai");
        expect(await line.innerText()).not.toContain("/");
      } finally {
        await context.close();
      }
    });

    test("Claude Code: a loopback return keeps its port", async ({ person, browser, baseURL }) => {
      const { context, page } = await open(browser, baseURL!, person.sessionFile, width);
      try {
        await page.goto(consentPath(LOCAL));
        const line = lineOf(page);
        await expect(line).toHaveText(`${LEAD} localhost:33418`);
        await expect(line.locator("strong")).toHaveText("localhost:33418");
        expect(await line.innerText()).not.toContain("callback");
      } finally {
        await context.close();
      }
    });

    test("the line is DM Mono 13px in ink and its host is bolder than the rest", async ({
      person,
      browser,
      baseURL,
    }) => {
      const { context, page } = await open(browser, baseURL!, person.sessionFile, width);
      try {
        await page.goto(consentPath(CLAUDE));
        const line = lineOf(page);
        await expect(line).toBeVisible();
        const style = await line.evaluate((el) => {
          const own = getComputedStyle(el);
          const strong = getComputedStyle(el.querySelector("strong")!);
          const title = getComputedStyle(document.querySelector("main h1")!);
          const lead = [...document.querySelectorAll("main p")].find((p) =>
            p.textContent?.startsWith("Podrá leer"),
          )!;
          const probe = document.createElement("span");
          probe.style.fontFamily = "var(--font-mono)";
          document.body.append(probe);
          const mono = getComputedStyle(probe).fontFamily;
          probe.remove();
          return {
            mono,
            family: own.fontFamily,
            size: own.fontSize,
            color: own.color,
            weight: Number(own.fontWeight),
            hostWeight: Number(strong.fontWeight),
            hostFamily: strong.fontFamily,
            titleColor: title.color,
            leadColor: getComputedStyle(lead).color,
            marginTop: own.marginTop,
          };
        });
        // `/mono/` also matches the fallback `monospace`; Chivo Mono is the resolved `--font-mono`.
        expect(style.mono).toMatch(/^"?chivo[ _]mono/i);
        expect(style.family).toBe(style.mono);
        expect(style.hostFamily).toBe(style.mono);
        expect(style.size).toBe("13px");
        expect(style.color).toBe(style.titleColor);
        expect(style.color).not.toBe(style.leadColor);
        expect(style.hostWeight).toBeGreaterThan(style.weight);
      } finally {
        await context.close();
      }
    });

    test("the line sits under the h1 and above the paragraph, in the board's order", async ({
      person,
      browser,
      baseURL,
    }) => {
      const { context, page } = await open(browser, baseURL!, person.sessionFile, width);
      try {
        await page.goto(consentPath(CLAUDE));
        await expect(lineOf(page)).toBeVisible();
        const top = async (locator: Locator) => (await boxOf(locator));
        const eyebrow = await top(page.getByText(oauth.eyebrow, { exact: true }));
        const h1 = await top(page.getByRole("heading", { level: 1 }));
        const line = await top(lineOf(page));
        const lead = await top(page.getByText(oauth.consentLead, { exact: true }));
        const may = await top(page.getByText(oauth.may.read, { exact: true }));
        const never = await top(page.getByText(oauth.never.delete, { exact: true }));
        const allow = await top(page.getByRole("button", { name: oauth.allow, exact: true }));
        const deny = await top(page.getByRole("button", { name: oauth.deny, exact: true }));
        const foot = await top(page.getByText(/lo revocas cuando quieras/));

        expect(eyebrow.y).toBeLessThan(h1.y);
        expect(line.y).toBeGreaterThanOrEqual(h1.y + h1.height);
        expect(line.y + line.height).toBeLessThanOrEqual(lead.y);
        expect(lead.y + lead.height).toBeLessThanOrEqual(may.y);
        expect(may.y).toBeLessThan(never.y);
        expect(never.y).toBeLessThan(allow.y);
        expect(allow.y).toBeLessThan(deny.y);
        expect(deny.y).toBeLessThan(foot.y);
        // Margin-top 10 under the title: the line hangs from the h1, not from the page's foot.
        expect(line.y - (h1.y + h1.height)).toBeLessThan(40);
      } finally {
        await context.close();
      }
    });

    test("while «Permitir» is pending the line stays", async ({ person, browser, baseURL }) => {
      const { context, page } = await open(browser, baseURL!, person.sessionFile, width);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      try {
        await page.goto(consentPath(CLAUDE));
        await expect(lineOf(page)).toBeVisible();
        await page.route("**/oauth/autorizar**", async (route) => {
          if (route.request().method() === "POST") {
            await held;
            await route.abort();
            return;
          }
          await route.continue();
        });
        await page.getByRole("button", { name: oauth.allow, exact: true }).click();
        await expect(page.getByRole("button", { name: oauth.working, exact: true })).toBeDisabled();
        await expect(lineOf(page)).toHaveText(`${LEAD} claude.ai`);
        await expect(lineOf(page)).toBeVisible();
      } finally {
        release();
        await context.close();
      }
    });

    test("a refused answer shows the notice and the line stays", async ({ person, browser, baseURL }) => {
      const { context, page } = await open(browser, baseURL!, person.sessionFile, width);
      try {
        await page.goto(consentPath(CLAUDE));
        await expect(lineOf(page)).toBeVisible();
        // The session lapses between seeing the screen and answering it.
        await context.clearCookies();
        await page.getByRole("button", { name: oauth.allow, exact: true }).click();
        await expect(appAlerts(page)).toBeVisible();
        await expect(lineOf(page)).toHaveText(`${LEAD} claude.ai`);
        await expect(page.getByRole("button", { name: oauth.allow, exact: true })).toBeEnabled();
      } finally {
        await context.close();
      }
    });

    test("signed out and an unregistered redirect carry no such line", async ({ person, browser, baseURL }) => {
      const out = await open(browser, baseURL!, signedOut, width);
      try {
        await out.page.goto(consentPath(CLAUDE));
        await expect(out.page.getByText(oauth.signedOut.lead, { exact: true })).toBeVisible();
        expect(await out.page.locator("body").innerText()).not.toContain(LEAD);
      } finally {
        await out.context.close();
      }
      const invalid = await open(browser, baseURL!, person.sessionFile, width);
      try {
        await invalid.page.goto(consentPath(UNREGISTERED));
        await expect(invalid.page.getByRole("heading", { level: 1, name: oauth.invalid.title })).toBeVisible();
        expect(await invalid.page.locator("body").innerText()).not.toContain(LEAD);
      } finally {
        await invalid.context.close();
      }
    });
  });
}

test("at 360 a 63-character host breaks inside the column", async ({ person, browser, baseURL }) => {
  const { context, page } = await open(browser, baseURL!, person.sessionFile, 360);
  try {
    await page.goto(consentPath(LONG));
    const line = lineOf(page);
    await expect(line).toHaveText(`${LEAD} ${LONG_HOST}`);
    await noOverflow(page, 360);
    const box = (await boxOf(line));
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    const host = (await boxOf(line.locator("strong")));
    expect(host.x + host.width).toBeLessThanOrEqual(360);
    // Broken onto more than one line, not shrunk to fit.
    expect(host.height).toBeGreaterThan(30);
    expect(await line.evaluate((el) => getComputedStyle(el).fontSize)).toBe("13px");
  } finally {
    await context.close();
  }
});
