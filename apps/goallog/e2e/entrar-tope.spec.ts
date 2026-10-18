import type { Browser, Page } from "@playwright/test";

import { test, expect, visit } from "./fixtures";

// RP-138, RP-137: a send or a resend refused at the day's cap reads that the door opens again tomorrow;
// Auth's own 429 keeps «en unos minutos». The words are the board «EntrarTopeDiario», written here as
// literals. Every Server Action answer is made by hand, so no mail is sent and no cap is waited for:
// the first send is answered `ok` to reach the code step, the refusal is whatever the test hands in.

const W = {
  emailLabel: "Correo electrónico",
  send: "Enviar código",
  codeLabel: "Código del correo",
  resend: "Pedir otro código",
  capped: "Ya pediste varios códigos hoy. Prueba de nuevo mañana.",
  rate: "Demasiados intentos. Prueba de nuevo en unos minutos.",
  sentTitle: "Revisa tu correo",
};

const RESEND_MS = 60_000;
const EMAIL = "tope-diario@example.com";

type Answer = { ok: true } | { ok: false; error: string };

// Answers the n-th Server Action post with the n-th answer (the last repeats); returns the post count.
async function answerInOrder(page: Page, answers: Answer[]): Promise<{ calls: number }> {
  const seen = { calls: 0 };
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    const answer = answers[Math.min(seen.calls, answers.length - 1)];
    seen.calls += 1;
    const body = [
      '0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}',
      `1:${JSON.stringify(answer)}`,
      "",
    ].join("\n");
    await route.fulfill({ status: 200, contentType: "text/x-component", body });
  });
  return seen;
}

async function open(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 360, height: 740 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.clock.install({ time: Date.now() });
  return { context, page };
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function toCodeStep(page: Page, answers: Answer[]) {
  const seen = await answerInOrder(page, [{ ok: true }, ...answers]);
  await visit(page, "/entrar");
  await page.getByLabel(W.emailLabel).fill(EMAIL);
  await page.getByRole("button", { name: W.send, exact: true }).click();
  await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toBeVisible();
  await page.clock.fastForward(RESEND_MS + 1_000);
  return seen;
}

test("Refused · send capped: the field's hint reads «mañana», never «unos minutos», the button is ready and the address kept", async ({
  browser,
  baseURL,
}) => {
  // Kills: `capped` mapped to the `rateLimited` key (the minutes sentence), the key missing from
  // account.json (the screen prints the raw key or throws), the button left disabled, the address cleared.
  const { context, page } = await open(browser, baseURL!);
  try {
    const seen = await answerInOrder(page, [{ ok: false, error: "capped" }]);
    await visit(page, "/entrar");
    const field = page.getByLabel(W.emailLabel);
    await field.fill(EMAIL);
    await page.getByRole("button", { name: W.send, exact: true }).click();
    await expect(page.getByText(W.capped, { exact: true })).toBeVisible();
    await expect(field).toHaveAccessibleDescription(W.capped);
    await expect(page.getByText("unos minutos")).toHaveCount(0);
    await expect(page.getByRole("button", { name: W.send, exact: true })).toBeEnabled();
    await expect(field).toHaveValue(EMAIL);
    expect(seen.calls).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test("Refused · resend capped: an alert under «Pedir otro código» reads «mañana», the button is ready, the code kept", async ({
  browser,
  baseURL,
}) => {
  // Kills: the resend refusal drawn with the minutes sentence, the key missing, the alert role lost,
  // the button left disabled or back on a countdown, the typed code cleared.
  const { context, page } = await open(browser, baseURL!);
  try {
    const seen = await toCodeStep(page, [{ ok: false, error: "capped" }]);
    await page.getByLabel(W.codeLabel).fill("123");
    await page.getByRole("button", { name: W.resend, exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: W.capped });
    await expect(alert).toBeVisible();
    await expect(page.getByText("unos minutos")).toHaveCount(0);
    await expect(page.getByRole("button", { name: W.resend, exact: true })).toBeEnabled();
    await expect(page.getByLabel(W.codeLabel)).toHaveValue("123");
    await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toBeVisible();
    expect(seen.calls).toBe(2);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test("Auth 429 unchanged: a resend answered `rateLimited` still reads «en unos minutos», not the cap words", async ({
  browser,
  baseURL,
}) => {
  // Kills: the cap words reused for Auth's 429 (the person told to wait a day for a minutes-long window).
  const { context, page } = await open(browser, baseURL!);
  try {
    await toCodeStep(page, [{ ok: false, error: "rateLimited" }]);
    await page.getByRole("button", { name: W.resend, exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: W.rate })).toBeVisible();
    await expect(page.getByText(W.capped)).toHaveCount(0);
    await expect(page.getByRole("button", { name: W.resend, exact: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("Auth 429 unchanged on the address form: a send answered `rateLimited` reads «en unos minutos»", async ({
  browser,
  baseURL,
}) => {
  // Kills: the cap words reused for Auth's 429 on the first send.
  const { context, page } = await open(browser, baseURL!);
  try {
    await answerInOrder(page, [{ ok: false, error: "rateLimited" }]);
    await visit(page, "/entrar");
    await page.getByLabel(W.emailLabel).fill(EMAIL);
    await page.getByRole("button", { name: W.send, exact: true }).click();
    await expect(page.getByLabel(W.emailLabel)).toHaveAccessibleDescription(W.rate);
    await expect(page.getByText(W.capped)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
