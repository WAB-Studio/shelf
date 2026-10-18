import { randomBytes, randomUUID } from "node:crypto";

import type { Browser, Page, Route } from "@playwright/test";
import { registerOAuthClient } from "@repo/harness-registry";
import postgres from "postgres";

import { test, expect, visit } from "./fixtures";

// RP-136, RP-137, board «EntrarSinRespuesta»: a send, a resend or a check that gets no answer in
// 8 s says so and frees every control; an answer that arrives later still lands, for the newest
// attempt only. The action POST is held behind a gate and the page's clock is moved; the words are
// the board's, written as literals. Every address is listed in the local inbox's allow-list and
// every mail goes to mailpit (:54324).

const MAILBOX = "http://127.0.0.1:54324";
const REDIRECT = "http://localhost:6274/oauth/callback";
const signedOut = { cookies: [], origins: [] };
const from = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::3`;

const W = {
  sentTitle: "Revisa tu correo",
  sentBody: (email: string) => `Te mandamos un código de seis números a ${email}. Vence en una hora.`,
  codeLabel: "Código del correo",
  enter: "Entrar",
  checking: "Comprobando…",
  other: "Usar otro correo",
  emailLabel: "Correo electrónico",
  send: "Enviar código",
  sending: "Enviando…",
  resend: "Pedir otro código",
  resent: (email: string) => `Te mandamos otro código a ${email}. Usa el del último correo.`,
  timedOut: "No sabemos si se envió. Revisa tu correo antes de pedir otro.",
  timedOutCheck: "No sabemos si se comprobó el código. Espera un momento antes de escribirlo otra vez.",
  rate: "Demasiados intentos. Prueba de nuevo en unos minutos.",
};

const PENDING_KEY = "goallog.pending-sign-in";
const RESEND_MS = 60_000;
const BEFORE = 7_900;
const AFTER = 8_100;

function invitee(): string {
  return `harness-inv-${randomUUID().slice(0, 6)}@gmail.com`;
}

async function listAddress(db: postgres.Sql, email: string) {
  await db`insert into goals.allowed_emails (email) values (${email}) on conflict do nothing`;
}

async function register(db: postgres.Sql, email: string) {
  const runId = process.env.HARNESS_RUN_ID!;
  await db`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

async function forget(db: postgres.Sql, email: string) {
  const ids = await db<{ id: string }[]>`select id from auth.users where email = ${email}`;
  for (const { id } of ids) {
    await db`delete from harness.identities where user_id = ${id}`;
    await db`delete from auth.users where id = ${id}`;
  }
  await db`delete from goals.allowed_emails where email = ${email}`;
}

async function sessionsOf(db: postgres.Sql, email: string): Promise<number> {
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from auth.sessions s join auth.users u on u.id = s.user_id where u.email = ${email}`;
  return n;
}

async function mailedCode(email: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const found = await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
      id = found.messages?.[0]?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json();
  const alone = /^\s*(\d{6})\s*$/m.exec(`${message.Text}`)?.[1];
  expect(alone, "the mail's text carries the code alone on a line").toBeTruthy();
  return alone!;
}

// Every action POST waits here until the spec lets it go: really, or answered by hand.
type Held = {
  body: string;
  proceed(): Promise<void>;
  answer(result: { ok: false; error: string }): Promise<void>;
};

function holdActions(page: Page): Promise<Held[]> {
  const held: Held[] = [];
  return page
    .route("**/*", async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
      let settle!: (act: (route: Route) => Promise<void>) => void;
      const turn = new Promise<(route: Route) => Promise<void>>((resolveTurn) => (settle = resolveTurn));
      const used = (act: (route: Route) => Promise<void>) => async () => {
        settle(act);
      };
      held.push({
        body: request.postData() ?? "",
        proceed: used((r) => r.continue()),
        answer: (result) =>
          used((r) =>
            r.fulfill({
              status: 200,
              contentType: "text/x-component",
              body: [
                '0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}',
                `1:${JSON.stringify(result)}`,
                "",
              ].join("\n"),
            }),
          )(),
      } as Held);
      await (
        await turn
      )(route).catch(() => undefined);
    })
    .then(() => held);
}

async function heldCount(held: Held[], n: number) {
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(n);
}

// Lets any call still held go, so a closing context never waits on a gate.
async function drain(held: Held[]) {
  for (const h of held) await h.proceed().catch(() => undefined);
}

async function open(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    storageState: signedOut,
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    extraHTTPHeaders: { "x-forwarded-for": from },
  });
  const page = await context.newPage();
  await page.clock.install({ time: Date.now() });
  return { context, page };
}

// Types the address and sends for real; stops at the code step.
async function askForCode(page: Page, db: postgres.Sql, email: string, path = "/entrar") {
  await visit(page, path);
  await page.getByLabel(W.emailLabel).fill(email);
  await page.getByRole("button", { name: W.send, exact: true }).click();
  await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toBeVisible();
  await register(db, email);
}

const codeField = (page: Page) => page.getByLabel(W.codeLabel);
const enterButton = (page: Page) => page.getByRole("button", { name: W.enter, exact: true });
const otherButton = (page: Page) => page.getByRole("button", { name: W.other, exact: true });
const resendButton = (page: Page) => page.getByRole("button", { name: /^Pedir otro (código|en \d+ s)$/ });
const pendingRaw = (page: Page) => page.evaluate((key) => localStorage.getItem(key), PENDING_KEY);

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectCodeStepUsable(page: Page) {
  await expect(codeField(page)).toBeEnabled();
  await expect(enterButton(page)).toBeEnabled();
  await expect(otherButton(page)).toBeEnabled();
}

// The answer's trip back to the page has no visible mark; a refused or ignored answer is given this long to show.
const lateAnswerGrace = (page: Page) => page.waitForTimeout(800);

async function startSend(page: Page, email: string) {
  await visit(page, "/entrar");
  await page.getByLabel(W.emailLabel).fill(email);
  await page.getByRole("button", { name: W.send, exact: true }).click();
}

async function startResend(page: Page, held: Held[], n = 1) {
  await page.clock.fastForward(RESEND_MS + 1_000);
  await page.getByRole("button", { name: W.resend, exact: true }).click();
  await heldCount(held, n);
}

test("Pending · send: held for 7.9 s the button still reads «Enviando…», disabled, and no timeout sentence shows", async ({
  browser,
  baseURL,
}) => {
  // Kills: a timer that fires at 0 s, or a shorter limit than 8 s.
  const { context, page } = await open(browser, baseURL!);
  const held = await holdActions(page);
  try {
    await startSend(page, invitee());
    await heldCount(held, 1);
    await page.clock.fastForward(BEFORE);
    const pending = page.getByRole("button", { name: W.sending, exact: true });
    await expect(pending).toBeVisible();
    await expect(pending).toBeDisabled();
    await expect(page.getByText(W.timedOut, { exact: true })).toHaveCount(0);
  } finally {
    await drain(held);
    await context.close();
  }
});

test("Refused · send timed out: at 8.1 s the field's hint reads the timeout, «Enviar código» is enabled, the address kept, at 360", async ({
  browser,
  baseURL,
}) => {
  // Kills: no timer (today: «Enviando…» for good), the address cleared, the sentence drawn elsewhere than the hint.
  const email = invitee();
  const { context, page } = await open(browser, baseURL!);
  const held = await holdActions(page);
  try {
    await startSend(page, email);
    await heldCount(held, 1);
    await page.clock.fastForward(AFTER);
    await expect(page.getByText(W.timedOut, { exact: true })).toBeVisible();
    await expect(page.getByLabel(W.emailLabel)).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: W.send, exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: W.sending, exact: true })).toHaveCount(0);
    await expect(page.getByLabel(W.emailLabel)).toHaveValue(email);
    await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toHaveCount(0);
    await expectNoOverflow(page);
  } finally {
    await drain(held);
    await context.close();
  }
});

test("Refused · resend timed out: the alert under the button, every control enabled, the countdown still the first send's, the typed code kept, at 360", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: a timer missing, `at` reset on the timeout (the button would count 60 s again), the code cleared.
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const before = await pendingRaw(page);
    expect(before).not.toBeNull();
    await codeField(page).fill("123456");
    const held = await holdActions(page);
    try {
      await startResend(page, held);
      await expect(page.getByRole("button", { name: W.sending, exact: true })).toBeDisabled();
      await page.clock.fastForward(AFTER);
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toBeVisible();
      await expect(page.getByRole("button", { name: W.sending, exact: true })).toHaveCount(0);
      await expectCodeStepUsable(page);
      await expect(resendButton(page)).toHaveText(W.resend);
      await expect(resendButton(page)).toBeEnabled();
      await expect(codeField(page)).toHaveValue("123456");
      expect(await pendingRaw(page)).toBe(before);
      await expect(page.getByText(W.resent(email))).toHaveCount(0);
      await expectNoOverflow(page);
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("Refused · check timed out: the field's hint reads the check timeout, the code kept, every control enabled, at 360", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: `checking` left true («Comprobando…» for good), the code cleared, the resend's sentence used for a check.
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const held = await holdActions(page);
    try {
      await codeField(page).fill("123456");
      await enterButton(page).click();
      await heldCount(held, 1);
      await page.clock.fastForward(BEFORE);
      await expect(page.getByRole("button", { name: W.checking, exact: true })).toBeDisabled();
      await expect(page.getByText(W.timedOutCheck, { exact: true })).toHaveCount(0);
      await page.clock.fastForward(AFTER - BEFORE);
      await expect(page.getByText(W.timedOutCheck, { exact: true })).toBeVisible();
      await expect(page.getByText(W.timedOut, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: W.checking, exact: true })).toHaveCount(0);
      await expect(codeField(page)).toHaveValue("123456");
      await expect(codeField(page)).toHaveAttribute("aria-invalid", "true");
      await expectCodeStepUsable(page);
      await expectNoOverflow(page);
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("Done · late send: released after the timeout, the code step opens for that address and the pending record holds it", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: a late answer dropped (WordBook's way), the pending record not saved.
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  const held = await holdActions(page);
  try {
    await startSend(page, email);
    await heldCount(held, 1);
    await page.clock.fastForward(AFTER);
    await expect(page.getByText(W.timedOut, { exact: true })).toBeVisible();
    await held[0].proceed();
    await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toBeVisible();
    await expect(page.getByText(W.sentBody(email), { exact: true })).toBeVisible();
    await expect(page.getByText(W.timedOut, { exact: true })).toHaveCount(0);
    expect(JSON.parse((await pendingRaw(page))!).email).toBe(email);
    await register(db, email);
  } finally {
    await drain(held);
    await context.close();
    await forget(db, email);
  }
});

test("Done · late resend: released after the timeout, the confirmation shows, the wait restarts, the code typed since is kept, the record moves on", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: late answers dropped, the code cleared as an on-time resend does, `at` not saved.
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const before = JSON.parse((await pendingRaw(page))!) as { at: number };
    const held = await holdActions(page);
    try {
      await startResend(page, held);
      await page.clock.fastForward(AFTER);
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toBeVisible();
      await codeField(page).fill("654321");
      await held[0].proceed();
      await expect(page.getByText(W.resent(email), { exact: true })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toHaveCount(0);
      await expect(resendButton(page)).toBeDisabled();
      await expect(resendButton(page)).toHaveText(/^Pedir otro en (59|60) s$/);
      await expect(codeField(page)).toHaveValue("654321");
      expect(JSON.parse((await pendingRaw(page))!).at).toBeGreaterThan(before.at);
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("Done · late check: a good code released after the timeout lands on /, the pending record gone, one session", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: the unmount clearing the record only while the check is not timed out ("clear the flag on timeout"),
  // or a landing that never happens once the promise lost the race.
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const code = await mailedCode(email);
    const held = await holdActions(page);
    try {
      await codeField(page).fill(code);
      await enterButton(page).click();
      await heldCount(held, 1);
      await page.clock.fastForward(AFTER);
      await expect(page.getByText(W.timedOutCheck, { exact: true })).toBeVisible();
      await held[0].proceed();
      await expect(page).toHaveURL(new RegExp(`^${baseURL!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`));
      await expect.poll(() => pendingRaw(page)).toBeNull();
      expect(await sessionsOf(db, email)).toBe(1);
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("Cancelled · send: a new address sent after a timeout owns the screen; the first answer, released later, changes nothing", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: applying every late answer (the screen would jump back to the first address and its record).
  const first = invitee();
  const second = invitee();
  await listAddress(db, first);
  await listAddress(db, second);
  const { context, page } = await open(browser, baseURL!);
  const held = await holdActions(page);
  try {
    await startSend(page, first);
    await heldCount(held, 1);
    await page.clock.fastForward(AFTER);
    await expect(page.getByText(W.timedOut, { exact: true })).toBeVisible();
    await page.getByLabel(W.emailLabel).fill(second);
    await page.getByRole("button", { name: W.send, exact: true }).click();
    // Next runs one action at a time: the second send waits behind the first, which is still held.
    await page.getByRole("button", { name: W.sending, exact: true }).waitFor();
    await held[0].proceed();
    await mailedCode(first);
    await lateAnswerGrace(page);
    // The first answer is stale: the screen is still on the second attempt, not on the first address's code step.
    await expect(page.getByRole("button", { name: W.sending, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toHaveCount(0);
    expect(await pendingRaw(page)).toBeNull();
    await heldCount(held, 2);
    await held[1].proceed();
    await expect(page.getByText(W.sentBody(second), { exact: true })).toBeVisible();
    await expect(page.getByText(W.sentBody(first), { exact: true })).toHaveCount(0);
    expect(JSON.parse((await pendingRaw(page))!).email).toBe(second);
    await register(db, first);
    await register(db, second);
  } finally {
    await drain(held);
    await context.close();
    await forget(db, first);
    await forget(db, second);
  }
});

test("Cancelled · resend: after «Usar otro correo» the released resend does not reopen the code step", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: applying every late answer (the code step returns for a person who left it).
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const held = await holdActions(page);
    try {
      await startResend(page, held);
      await page.clock.fastForward(AFTER);
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toBeVisible();
      await otherButton(page).click();
      await expect(page.getByLabel(W.emailLabel)).toBeVisible();
      await held[0].proceed();
      await mailedCode(email);
      await lateAnswerGrace(page);
      await expect(page.getByLabel(W.emailLabel)).toBeVisible();
      await expect(codeField(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toHaveCount(0);
      expect(await pendingRaw(page)).toBeNull();
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("Late refusal dropped: a resend answered «rateLimited» after the timeout leaves the timeout sentence alone", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: applying late refusals (a second sentence replaces or joins the first).
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const held = await holdActions(page);
    try {
      await startResend(page, held);
      await page.clock.fastForward(AFTER);
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toBeVisible();
      await held[0].answer({ ok: false, error: "rateLimited" });
      await lateAnswerGrace(page);
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toBeVisible();
      await expect(page.getByText(W.rate)).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: /^(Demasiados|No sabemos)/ })).toHaveCount(1);
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("On time: a refusal inside 8 s reads as today and the timer is spent, so 10 s later it says nothing more", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: a timer not cleared on settle (the timeout sentence overwrites the refusal afterwards).
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email);
    const held = await holdActions(page);
    try {
      await startResend(page, held);
      await page.clock.fastForward(3_000);
      await held[0].answer({ ok: false, error: "rateLimited" });
      await expect(page.getByRole("alert").filter({ hasText: W.rate })).toBeVisible();
      await page.clock.fastForward(10_000);
      await lateAnswerGrace(page);
      await expect(page.getByRole("alert").filter({ hasText: W.rate })).toBeVisible();
      await expect(page.getByText(W.timedOut)).toHaveCount(0);
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});

test("On time: a send answered inside 8 s opens the code step and 10 s later no timeout sentence appears", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: a send timer not cleared on settle.
  const email = invitee();
  await listAddress(db, email);
  const { context, page } = await open(browser, baseURL!);
  const held = await holdActions(page);
  try {
    await startSend(page, email);
    await heldCount(held, 1);
    await page.clock.fastForward(3_000);
    await held[0].proceed();
    await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toBeVisible();
    await register(db, email);
    await page.clock.fastForward(10_000);
    await lateAnswerGrace(page);
    await expect(page.getByRole("heading", { name: W.sentTitle, exact: true })).toBeVisible();
    await expect(page.getByText(W.timedOut)).toHaveCount(0);
    await expect(page.getByText(W.timedOutCheck)).toHaveCount(0);
  } finally {
    await drain(held);
    await context.close();
    await forget(db, email);
  }
});

test("Consent too: on the signed-out consent a resend timed out and tapped again keeps `next` in the second POST", async ({
  browser,
  baseURL,
  db,
}) => {
  // Kills: `next` dropped from the retry after a timeout.
  const email = invitee();
  await listAddress(db, email);
  const meta = await fetch(`${baseURL}/.well-known/oauth-protected-resource`);
  const { resource } = (await meta.json()) as { resource: string };
  const registered = await fetch(`${baseURL}/oauth/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify({ client_name: `Claude ${randomBytes(3).toString("hex")}`, redirect_uris: [REDIRECT] }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await registerOAuthClient(sql, client_id);
  } finally {
    await sql.end();
  }
  const consent = `/oauth/autorizar?${new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
    state: "estado-m7-sin-respuesta",
    resource,
  }).toString()}`;
  const { context, page } = await open(browser, baseURL!);
  try {
    await askForCode(page, db, email, consent);
    const held = await holdActions(page);
    try {
      await startResend(page, held);
      await page.clock.fastForward(AFTER);
      await expect(page.getByRole("alert").filter({ hasText: W.timedOut })).toBeVisible();
      await resendButton(page).click();
      // Next runs one action at a time: the retry is posted once the held first one is answered.
      await held[0].answer({ ok: false, error: "rateLimited" });
      await heldCount(held, 2);
      expect(held[1].body).toContain(email);
      expect(held[1].body).toContain("estado-m7-sin-respuesta");
    } finally {
      await drain(held);
    }
  } finally {
    await context.close();
    await forget(db, email);
  }
});
