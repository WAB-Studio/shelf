import type { Browser, BrowserContext } from "@playwright/test";

import account from "../messages/es/account.json";
import { landRecoveryToken, redeemToken, sql as mintSql } from "../scripts/harness/mint-session";
import { expect, mintDisposablePerson, test, visit } from "./fixtures";

// RP-141, board `MetasCerrarSesion`: «Cerrar sesión» at the foot of /metas ends
// this device's session and nothing else. Every test mints a person of its own
// (a UUID-named session file): signing out the lane's shared session, or the
// worker's, would break the specs that run after.
const SIGN_OUT = "Cerrar sesión";
const PENDING = "Cerrando…";
const PARTIAL = "Cerraste sesión en este dispositivo, pero no pudimos confirmarlo con el servidor.";

test.afterAll(async () => {
  await mintSql.end();
});

async function emailOf(db: import("postgres").Sql, id: string): Promise<string> {
  const [row] = await db<{ email: string }[]>`select email from auth.users where id = ${id}`;
  return row.email;
}

async function deviceOf(browser: Browser, sessionFile: string): Promise<BrowserContext> {
  return browser.newContext({ storageState: sessionFile, viewport: { width: 360, height: 740 }, hasTouch: true });
}

test.describe("«Cerrar sesión» at the foot of /metas (RP-141)", () => {
  test("idle: «Tu cuenta», who is signed in, and a button named account.signOut", async ({ browser, db, baseURL }) => {
    const person = mintDisposablePerson(baseURL!);
    const email = await emailOf(db, person.id);
    const context = await deviceOf(browser, person.sessionFile);
    const page = await context.newPage();
    await visit(page, "/metas");

    await expect(page.getByText("Tu cuenta", { exact: true })).toBeVisible();
    await expect(page.getByText(`Entraste como ${email}`, { exact: true })).toBeVisible();

    // The words the board draws, and the key the app reads them from.
    expect((account as Record<string, unknown>).signOut).toBe(SIGN_OUT);
    const button = page.getByRole("button", { name: String((account as Record<string, unknown>).signOut) });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await context.close();
  });

  test("pending: disabled and «Cerrando…» while the action is held", async ({ browser, db, baseURL }) => {
    const person = mintDisposablePerson(baseURL!);
    void db;
    const context = await deviceOf(browser, person.sessionFile);
    const page = await context.newPage();
    await visit(page, "/metas");

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let intercepted = 0;
    await page.route("**/metas", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        intercepted += 1;
        await held;
      }
      await route.continue();
    });

    await page.getByRole("button", { name: SIGN_OUT }).click();
    const pending = page.getByRole("button", { name: PENDING });
    await expect(pending).toBeVisible();
    await expect(pending).toBeDisabled();
    expect(intercepted).toBe(1);
    expect(new URL(page.url()).pathname).toBe("/metas");

    release();
    await page.waitForURL("**/entrar");
    await context.close();
  });

  test("done: lands on /entrar, and /metas then asks to sign in again", async ({ browser, baseURL }) => {
    const person = mintDisposablePerson(baseURL!);
    const context = await deviceOf(browser, person.sessionFile);
    const page = await context.newPage();
    await visit(page, "/metas");

    await page.getByRole("button", { name: SIGN_OUT }).click();
    await page.waitForURL((url) => url.pathname === "/entrar");
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByText(PARTIAL)).toHaveCount(0);

    await page.goto("/metas");
    await page.waitForURL((url) => url.pathname === "/entrar");
    await context.close();
  });

  test("other device: a second session of the same person still opens /metas", async ({ browser, db, baseURL }) => {
    const first = mintDisposablePerson(baseURL!);
    const email = await emailOf(db, first.id);
    // A second sign-in of the same person: its own session row and cookies.
    const cookies = await redeemToken(await landRecoveryToken(first.id, email));
    const count = async () =>
      (await db<{ n: number }[]>`select count(*)::int as n from auth.sessions where user_id = ${first.id}`)[0].n;
    expect(await count()).toBe(2);

    const here = await deviceOf(browser, first.sessionFile);
    const there = await browser.newContext({ storageState: { cookies, origins: [] }, viewport: { width: 360, height: 740 } });
    const hereTab = await here.newPage();
    await visit(hereTab, "/metas");
    await hereTab.getByRole("button", { name: SIGN_OUT }).click();
    await hereTab.waitForURL((url) => url.pathname === "/entrar");

    // Only this device's session went; a global sign-out would take both.
    expect(await count()).toBe(1);
    const thereTab = await there.newPage();
    await visit(thereTab, "/metas");
    expect(new URL(thereTab.url()).pathname).toBe("/metas");
    await expect(thereTab.getByRole("button", { name: SIGN_OUT })).toBeVisible();
    await here.close();
    await there.close();
  });

  test("partial: /entrar?salida=parcial draws the board's line, and plain /entrar does not", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 740 } });
    const page = await context.newPage();

    await visit(page, "/entrar?salida=parcial");
    await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible();
    // Muted line under the lead, not an alert.
    await expect(page.getByRole("alert").filter({ hasText: PARTIAL })).toHaveCount(0);

    await visit(page, "/entrar");
    await expect(page.getByText(PARTIAL)).toHaveCount(0);
    await context.close();
  });
});
