import type { Page, Request } from "@playwright/test";

import messages from "../messages/es.json";
import { expect, test } from "./fixtures";

// RL-73, from Board «CuentaCódigo» and the plan's Done table, not from the
// component. Every action POST is simulated: `sendSignInLink` and
// `verifySignInCode` are told apart by their arguments (`[email]` against
// `[email, code]`). Words are the board's, written here whole.

const SENT = "Revisa tu correo y escribe aquí el código que te mandamos";
const FIELD = "Código del correo";
const ENTER = "Entrar";
const OTHER = "Usar otro correo";
const CHECKING = "Comprobando…";
const SHORT = "Escribe los seis números del correo";
const REFUSED = "Ese código no vale o ya venció";
const OUR_SIDE = "No se pudo comprobar el código. Escríbelo otra vez; si no entra, pide otro.";
const OFFLINE = "Sin conexión. No se pudo comprobar el código.";
const TOO_MANY = "Demasiados intentos. Prueba de nuevo en unos minutos.";

const EMAIL = "reader@example.com";
const CODE = "123456";
const MINUTE = 60_000;

// THE RULE: no test in this file may run the real action. A send that reaches
// it mails a real address and mints an `auth.users` row.
const RULE_MESSAGE =
  "a Server Action POST left the browser with no simulated answer: account-send-code.spec.ts never runs the real actions";

type Result = { ok: true } | { ok: false; error: string };
type VerifyAnswer = (call: { email: string; code: string; request: Request }) => Promise<Result | "abort"> | Result | "abort";

let unsimulated: string[] = [];
let verifyCalls: Array<{ email: string; code: string }> = [];
let sendCalls: string[] = [];

test.beforeEach(async ({ page }) => {
  unsimulated = [];
  verifyCalls = [];
  sendCalls = [];
  await page.route("**/cuenta", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) {
      await route.continue();
      return;
    }
    unsimulated.push(request.url());
    await route.abort();
  });
});

test.afterEach(() => {
  expect(unsimulated, RULE_MESSAGE).toEqual([]);
});

function flight(result: Result): string {
  return ['0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}', `1:${JSON.stringify(result)}`, ""].join("\n");
}

async function simulate(page: Page, verify: VerifyAnswer): Promise<void> {
  await page.route("**/cuenta", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) {
      await route.continue();
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(request.postData() ?? "");
    } catch {
      args = null;
    }
    if (Array.isArray(args) && args.length === 1 && typeof args[0] === "string") {
      sendCalls.push(args[0]);
      await route.fulfill({ status: 200, contentType: "text/x-component", body: flight({ ok: true }) });
      return;
    }
    if (Array.isArray(args) && args.length === 2 && typeof args[0] === "string" && typeof args[1] === "string") {
      const call = { email: args[0], code: args[1] };
      verifyCalls.push(call);
      const answer = await verify({ ...call, request });
      if (answer === "abort") {
        await route.abort("internetdisconnected");
        return;
      }
      await route.fulfill({ status: 200, contentType: "text/x-component", body: flight(answer) });
      return;
    }
    unsimulated.push(request.url());
    await route.abort();
  });
}

const field = (page: Page) => page.getByRole("textbox", { name: FIELD });
const emailField = (page: Page) => page.getByRole("textbox", { name: messages.account.emailLabel });

async function askForCode(page: Page): Promise<void> {
  await page.goto("/cuenta");
  await emailField(page).fill(EMAIL);
  await page.getByRole("button", { name: messages.account.copy.noSessionAction }).click();
  await expect(page.getByText(SENT)).toBeVisible();
}

async function enter(page: Page, code: string): Promise<void> {
  await field(page).fill(code);
  await page.getByRole("button", { name: ENTER }).click();
}

// The keys of `localStorage` whose value holds the address: the pending sign-in, whatever it is called.
const keptAddress = (page: Page) =>
  page.evaluate((address) => Object.keys(localStorage).filter((key) => (localStorage.getItem(key) ?? "").includes(address)), EMAIL);

test("after the send the screen asks for the code, with a way back", async ({ page }) => {
  await simulate(page, () => ({ ok: true }));
  await askForCode(page);

  expect(sendCalls).toEqual([EMAIL]);
  await expect(page.getByText(SENT)).toHaveAttribute("role", "status");
  await expect(field(page)).toBeVisible();
  await expect(page.getByRole("button", { name: ENTER })).toBeVisible();
  await expect(page.getByRole("button", { name: OTHER })).toBeVisible();
  // The email form is gone while the code is asked.
  await expect(emailField(page)).toHaveCount(0);
  await expect(field(page)).toHaveAttribute("maxlength", "6");
  await expect(field(page)).toHaveAttribute("inputmode", "numeric");
  await expect(field(page)).toHaveAttribute("autocomplete", "one-time-code");
  await expect(field(page)).toBeFocused();
});

test("a short code is refused on the screen and never asked of the server", async ({ page }) => {
  await simulate(page, () => ({ ok: true }));
  await askForCode(page);

  await enter(page, "12345");

  const line = page.getByText(SHORT);
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("role", "alert");
  expect(verifyCalls).toEqual([]);
  await enter(page, "");
  await expect(line).toBeVisible();
  expect(verifyCalls).toEqual([]);
});

test("the verify call carries the address that asked for the code and the six digits", async ({ page }) => {
  await simulate(page, () => ({ ok: false, error: "codeInvalid" }));
  await askForCode(page);

  await enter(page, CODE);
  await expect(page.getByText(REFUSED)).toBeVisible();
  expect(verifyCalls).toEqual([{ email: EMAIL, code: CODE }]);
});

test("while the answer is out the field and the button are locked and say so", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await simulate(page, async () => {
    await held;
    return { ok: false, error: "codeInvalid" };
  });
  await askForCode(page);

  await enter(page, CODE);

  const button = page.getByRole("button", { name: CHECKING });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(field(page)).toBeDisabled();
  release();
  await expect(page.getByText(REFUSED)).toBeVisible();
  await expect(field(page)).toBeEnabled();
});

test("a code that does not let in says wrong or expired, in an alert, and keeps the code", async ({ page }) => {
  await simulate(page, () => ({ ok: false, error: "codeInvalid" }));
  await askForCode(page);

  await enter(page, CODE);

  const line = page.getByText(REFUSED);
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("role", "alert");
  await expect(field(page)).toHaveValue(CODE);
  // The send's own words do not stand in for it.
  await expect(page.getByText(messages.account.errors.sendFailed)).toHaveCount(0);
  await expect(page.getByText(OUR_SIDE)).toHaveCount(0);
});

test("our side not answering says so, not that the code is wrong", async ({ page }) => {
  await simulate(page, () => ({ ok: false, error: "codeTimeout" }));
  await askForCode(page);

  await enter(page, CODE);

  const line = page.getByText(OUR_SIDE);
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("role", "alert");
  await expect(page.getByText(REFUSED)).toHaveCount(0);
  await expect(field(page)).toHaveValue(CODE);
});

test("too many tries says to wait", async ({ page }) => {
  await simulate(page, () => ({ ok: false, error: "rateLimited" }));
  await askForCode(page);

  await enter(page, CODE);

  const line = page.getByText(TOO_MANY);
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("role", "alert");
  await expect(page.getByText(REFUSED)).toHaveCount(0);
});

test("an answer the screen has no line for still paints an alert", async ({ page }) => {
  await simulate(page, () => ({ ok: false, error: "emailInvalid" }));
  await askForCode(page);

  await enter(page, CODE);

  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(1);
});

test("no network: the button gives up, names the connection, and «Reintentar» sends the same code again", async ({ page }) => {
  let attempts = 0;
  await simulate(page, () => (++attempts === 1 ? "abort" : { ok: true }));
  await askForCode(page);

  await enter(page, CODE);

  await expect(page.getByText(OFFLINE, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(REFUSED)).toHaveCount(0);
  await expect(field(page)).toHaveValue(CODE);
  const retry = page.getByRole("button", { name: messages.account.retry });
  await expect(retry).toBeEnabled();

  await retry.click();

  await expect.poll(() => verifyCalls.length).toBe(2);
  expect(verifyCalls[1]).toEqual({ email: EMAIL, code: CODE });
});

test("a request that never settles gives up on the clock", async ({ page }) => {
  await simulate(page, () => new Promise<never>(() => {}));
  await askForCode(page);

  const tappedAt = Date.now();
  await enter(page, CODE);

  await expect(page.getByText(OFFLINE, { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - tappedAt).toBeGreaterThanOrEqual(7_000);
});

test("a good code refreshes the screen once and forgets the pending address", async ({ page }) => {
  await simulate(page, () => ({ ok: true }));
  await page.goto("/cuenta");
  expect(await keptAddress(page)).toEqual([]);
  await emailField(page).fill(EMAIL);
  await page.getByRole("button", { name: messages.account.copy.noSessionAction }).click();
  await expect(page.getByText(SENT)).toBeVisible();
  expect(await keptAddress(page)).toHaveLength(1);

  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/cuenta" && request.url().includes("_rsc")) {
      refreshes.push(request.url());
    }
  });
  await enter(page, CODE);

  await expect.poll(() => refreshes.length).toBe(1);
  await page.waitForTimeout(1_500);
  expect(refreshes).toHaveLength(1);
  expect(verifyCalls).toEqual([{ email: EMAIL, code: CODE }]);
  expect(await keptAddress(page)).toEqual([]);
});

test("a refused code does not refresh the screen", async ({ page }) => {
  await simulate(page, () => ({ ok: false, error: "codeInvalid" }));
  await askForCode(page);
  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("_rsc")) refreshes.push(request.url());
  });

  await enter(page, CODE);
  await expect(page.getByText(REFUSED)).toBeVisible();
  await page.waitForTimeout(1_000);

  expect(refreshes).toEqual([]);
});

test("«Usar otro correo» brings the email form back with the address kept and the device forgetting it", async ({ page }) => {
  await simulate(page, () => ({ ok: true }));
  await page.goto("/cuenta");
  expect(await keptAddress(page)).toEqual([]);
  await emailField(page).fill(EMAIL);
  await page.getByRole("button", { name: messages.account.copy.noSessionAction }).click();
  await expect(page.getByText(SENT)).toBeVisible();

  await page.getByRole("button", { name: OTHER }).click();

  await expect(emailField(page)).toHaveValue(EMAIL);
  await expect(field(page)).toHaveCount(0);
  expect(await keptAddress(page)).toEqual([]);
  // A reload does not reopen the step that was left.
  await page.reload();
  await expect(emailField(page)).toBeVisible();
  await expect(field(page)).toHaveCount(0);
});

test("a reload at minute 5 reopens the code step for the same address; at minute 61 it is the email form", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-17T10:00:00Z") });
  await simulate(page, () => ({ ok: false, error: "codeInvalid" }));
  await askForCode(page);

  await page.clock.fastForward(5 * MINUTE);
  await page.reload();
  await expect(page.getByText(SENT)).toBeVisible();
  await expect(field(page)).toBeVisible();
  await enter(page, CODE);
  await expect(page.getByText(REFUSED)).toBeVisible();
  expect(verifyCalls).toEqual([{ email: EMAIL, code: CODE }]);

  await page.clock.fastForward(56 * MINUTE);
  await page.reload();
  await expect(emailField(page)).toBeVisible();
  await expect(field(page)).toHaveCount(0);
});

test("the 360 face has no overflow and every control is at least 44 px tall", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await simulate(page, () => ({ ok: true }));
  await askForCode(page);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const control of [field(page), page.getByRole("button", { name: ENTER }), page.getByRole("button", { name: OTHER })]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  }
});
