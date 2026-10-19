/**
 * Signing in with the six-digit code (RF-146): the step after «Revisa tu correo» (board «LoginCódigo»).
 *
 * Written from the contract and the board, not from `login-form.tsx`: every sentence the person reads
 * is spelled out here, so a changed value in `es.json` or `en.json` reddens a test; only the words
 * this slice leaves alone are read by key (`auth.sendLink` clicks the send button, whatever it says).
 *
 * The code is the one the local stack mailed: the spec reads it from mailpit (:54324) and types it
 * the way a person would. Nothing leaves the machine and the spec refuses any other stack; the
 * addresses end in `.invalid`. The answers «our side» and «too many» cannot be provoked on demand,
 * so the action's POST is answered by the browser with the reason the action would throw.
 *
 * Each address is registered under this worker's run the moment Auth has created it and dropped
 * after the file, as `sign-in.spec.ts` does.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { closeRun, openRun, runId } from "@repo/harness-registry";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { addressKey, callerKey } from "@/lib/auth/client-key";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import en from "@/messages/en.json";
import messages from "@/messages/es.json";

import { fixtureSql, purgeAuditTrail, purgeIdentity } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, seedGroup, test } from "./global-setup";

const MAILBOX = "http://127.0.0.1:54324";
const signedOut = { cookies: [], origins: [] };

// The board's words, spelled out.
const ES = {
  hint: "Te enviamos un código para entrar sin contraseña.",
  send: "Enviar código",
  sending: "Enviando el código",
  title: "Revisa tu correo",
  description: (email: string) => `Enviamos un código de seis números a ${email}. Escríbelo aquí para entrar.`,
  label: "Código del correo",
  enter: "Entrar",
  checking: "Comprobando el código",
  note: "El correo también trae un enlace: ábrelo en este navegador. Si no llega en unos minutos, revisa la carpeta de spam.",
  another: "Usar otro correo",
  incomplete: "Escribe los seis números del correo.",
  invalid: "Ese código no vale o ya venció. Usa el del último correo o pide otro.",
  timeout: "No se pudo comprobar el código. Vuelve a intentarlo; si no entra, pide otro.",
  tooMany: "Demasiados intentos con el código. Espera unos minutos.",
  resend: "Pedir otro código",
  resendIn: (seconds: number) => `Pedir otro en ${seconds} s`,
  resending: "Enviando otro código",
  resent: (email: string) => `Te mandamos otro código a ${email}. Usa el del último correo.`,
  capped: "Ya pediste varios códigos hoy. Usa el último que te llegó o vuelve mañana.",
};
const EN = {
  hint: "We send you a code to sign in without a password.",
  send: "Send code",
  title: "Check your email",
  description: (email: string) => `We sent a six-digit code to ${email}. Type it here to sign in.`,
  label: "Code from the email",
  enter: "Sign in",
  incomplete: "Type the six digits from the email.",
  invalid: "That code is wrong or expired. Use the one in the latest email or ask for another.",
  resend: "Ask for another code",
  resendIn: (seconds: number) => `Ask again in ${seconds} s`,
  resending: "Sending another code",
  resent: (email: string) => `We sent another code to ${email}. Use the one in the latest email.`,
  capped: "You already asked for several codes today. Use the latest one you got, or come back tomorrow.",
  rateLimited: "You asked for too many codes in a row. Wait a moment and try again.",
};

const stamp = randomUUID().slice(0, 8);
const SALT = process.env.CLIENT_KEY_SALT ?? "";
let serial = 0;
const minted: string[] = [];
const listedEmails: string[] = [];
const claimedKeys: string[] = [];

test.beforeAll(async ({ baseURL }) => {
  // Without the salt the caps are open (`noKey`) and every send below would pass for the wrong reason.
  expect(process.env.CLIENT_KEY_SALT?.length ?? 0, "CLIENT_KEY_SALT must be set (>= 16 chars): this file fails, never skips").toBeGreaterThanOrEqual(16);
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://unset.invalid");
  expect(["127.0.0.1", "localhost"], `Supabase is ${supabase.host}, not the local stack`).toContain(supabase.hostname);
  expect(["127.0.0.1", "localhost"], `the app is at ${baseURL}`).toContain(new URL(baseURL!).hostname);
  await openRun("e2e", fixtureSql);
});

test.afterAll(async () => {
  try {
    for (const email of minted) {
      const users = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
      for (const { id } of users) {
        await fixtureSql`delete from harness.identities where user_id = ${id}`;
        await purgeIdentity(id);
        await purgeAuditTrail([id]);
      }
    }
    await clearGroup();
    if (listedEmails.length) await fixtureSql`delete from finances.allowed_emails where email in ${fixtureSql(listedEmails)}`;
    if (claimedKeys.length) await fixtureSql`delete from finances.sign_in_claims where client_key in ${fixtureSql(claimedKeys)}`;
  } finally {
    await closeRun(fixtureSql);
  }
});

function newAddress(): string {
  serial += 1;
  const email = `harness-signin-code-${stamp}-${serial}@example.invalid`;
  minted.push(email);
  return email;
}

// A random /64 in 2001:db8::/32 per caller: the caller counter is shared by every lane and rerun.
function newCaller(): string {
  const group = () => randomBytes(2).toString("hex");
  return `2001:db8:${group()}:${group()}:${group()}::1`;
}

async function listAddress(email: string) {
  listedEmails.push(email);
  await fixtureSql`insert into finances.allowed_emails (email) values (${email.trim().toLowerCase()})`;
}

async function register(email: string) {
  await fixtureSql`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId()}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

async function fresh(browser: Browser, baseURL: string, storageState: Parameters<Browser["newContext"]>[0] = {}) {
  const ip = newCaller();
  claimedKeys.push(callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!);
  const context = await browser.newContext({
    baseURL,
    storageState: signedOut,
    ...storageState,
    extraHTTPHeaders: { "x-forwarded-for": ip },
  });
  return { context, page: await context.newPage() };
}

// The six digits of the newest message to `email`, read from the message the stack really sent.
async function mailedCode(email: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const found = (await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()) as {
        messages: { ID: string }[];
      };
      id = found.messages[0]?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = (await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json()) as { Text: string };
  // The code stands alone on its line (board «Correo»): the verify link's hex token can hold a run of six digits by chance.
  const runs = message.Text.match(/^\d{6}$/gm) ?? [];
  expect(runs, "the mail carries the code alone on one line of its text").toHaveLength(1);
  return runs[0]!;
}

const fieldOf = (page: Page, label = ES.label) => page.getByLabel(label, { exact: true });
const enterOf = (page: Page, name = ES.enter) => page.getByRole("button", { name, exact: true });
const anotherOf = (page: Page) => page.getByRole("button", { name: ES.another, exact: true });
const toasts = (page: Page) => page.locator("[data-sonner-toast]");

// Sends through the real action (the link button is clicked by key: its wording is not this file's claim).
async function askForCode(
  browser: Browser,
  baseURL: string,
  options: { path?: string; locale?: "es" | "en" } = {},
) {
  const { path, locale = "es" } = options;
  const email = newAddress();
  await listAddress(email);
  claimedKeys.push(addressKey(email, SALT));
  const { context, page } = await fresh(browser, baseURL);
  await page.goto(path ?? `/${locale}/login`);
  const copy = locale === "es" ? messages.auth : en.auth;
  await page.getByLabel(copy.emailLabel).fill(email);
  await page.getByRole("button", { name: copy.sendLink, exact: true }).click();
  await expect(page.getByRole("heading", { name: copy.sentTitle, exact: true })).toBeVisible();
  await register(email);
  const code = await mailedCode(email);
  return { email, code, context, page };
}

// A code that is not the mailed one (one chance in a million to collide, and then it takes the next).
const wrongCode = (code: string) => (code === "000000" ? "000001" : "000000");

// A POST from the code step that left the browser: the sends are over, so each one is the verification.
function countActionPosts(page: Page): () => number {
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) posts += 1;
  });
  return () => posts;
}

// What the action's answer looks like on the wire: Flight rows with the safe-action result.
const ACTION_URL = /\/(es|en)\/login/;
async function answerActionWith(page: Page, serverError: string, gate?: Promise<void>) {
  await page.route(ACTION_URL, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    if (gate) await gate;
    const body = [
      '0:{"a":"$@1","f":"","q":"","i":false,"b":"e2e0000000000000000"}',
      `1:${JSON.stringify({ serverError })}`,
      "",
    ].join("\n");
    await route.fulfill({ status: 200, contentType: "text/x-component", body });
  });
}

// The page has hydrated and its mount effects have run: an absence read before that holds for any code.
async function settled(page: Page) {
  await expect
    .poll(() => page.evaluate(() => Object.keys(document.querySelector("form, [role=status]") ?? {}).some((key) => key.startsWith("__reactFiber"))))
    .toBe(true);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0))));
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  return row.id;
}

test.describe("the code step", () => {
  test.skip(({ viewport }) => viewport?.width === 360, "the states are read once, on the laptop");

  test("the login says it sends a code: the hint and the button", async ({ browser, baseURL }) => {
    // Kills: leaving the old values («enlace») in es.json.
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await page.goto("/es/login");
      await expect(page.getByText(ES.hint, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: ES.send, exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("while the code is sent the button reads «Enviando el código» and is disabled", async ({ browser, baseURL }) => {
    // Kills: dropping `disabled={isPending}`; leaving `sending` at «Enviando el enlace».
    const email = newAddress();
    await listAddress(email);
    claimedKeys.push(addressKey(email, SALT));
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await page.route(ACTION_URL, async (route) => {
        if (route.request().method() === "POST") await new Promise((done) => setTimeout(done, 1_500));
        await route.continue();
      });
      await page.goto("/es/login");
      await page.getByLabel(messages.auth.emailLabel).fill(email);
      await page.getByRole("button", { name: messages.auth.sendLink, exact: true }).click();
      const pending = page.getByRole("button", { name: ES.sending, exact: true });
      await expect(pending).toBeVisible();
      await expect(pending).toBeDisabled();
      await expect(page.getByRole("heading", { name: ES.title, exact: true })).toBeVisible();
      await register(email);
    } finally {
      await context.close();
    }
  });

  test("sent: the address, the code field in focus, «Entrar» and «Usar otro correo»", async ({ browser, baseURL }) => {
    // Kills: rendering the old panel (no field); a field without autofocus, numeric keyboard, one-time-code or six characters.
    const { email, context, page } = await askForCode(browser, baseURL!);
    try {
      await expect(page.getByRole("heading", { name: ES.title, exact: true })).toBeVisible();
      await expect(page.getByText(ES.description(email), { exact: true })).toBeVisible();
      const field = fieldOf(page);
      await expect(field).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute("inputmode", "numeric");
      await expect(field).toHaveAttribute("autocomplete", "one-time-code");
      await expect(field).toHaveAttribute("maxlength", "6");
      await expect(enterOf(page)).toBeVisible();
      await expect(page.getByText(ES.note, { exact: true })).toBeVisible();
      await expect(anotherOf(page)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  for (const typed of ["", "12345", "12a456"]) {
    test(`a code of «${typed}» says the six numbers are owed, marks the field and asks nothing`, async ({ browser, baseURL }) => {
      // Kills: dropping `zodResolver(signInCodeSchema)`; sending a short code to Auth.
      const { context, page } = await askForCode(browser, baseURL!);
      try {
        const posts = countActionPosts(page);
        const field = fieldOf(page);
        await field.fill(typed);
        await enterOf(page).click();
        await expect(field).toHaveAttribute("aria-invalid", "true");
        await expect(field).toHaveAccessibleDescription(ES.incomplete);
        await expect(toasts(page)).toHaveCount(0);
        expect(posts()).toBe(0);
      } finally {
        await context.close();
      }
    });
  }

  test("pending: «Comprobando el código», the field and «Usar otro correo» disabled", async ({ browser, baseURL }) => {
    // Kills: leaving the field enabled while pending; leaving «Usar otro correo» enabled.
    const { code, context, page } = await askForCode(browser, baseURL!);
    try {
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      // The held answer is simulated, so the mailed code is never spent by this test.
      await answerActionWith(page, "errors.codeTimeout", held);
      await fieldOf(page).fill(code);
      await enterOf(page).click();

      const checking = page.getByRole("button", { name: ES.checking, exact: true });
      await expect(checking).toBeVisible();
      await expect(checking).toBeDisabled();
      await expect(fieldOf(page)).toBeDisabled();
      await expect(anotherOf(page)).toBeDisabled();

      release();
      await expect(fieldOf(page)).toBeEnabled();
      await expect(anotherOf(page)).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  test("a code that is not the mailed one is refused under the field, kept, without a toast", async ({ browser, baseURL }) => {
    // Kills: toasting the error instead; clearing the field; `codeInvalid` not reaching the field.
    const { code, context, page } = await askForCode(browser, baseURL!);
    try {
      const typed = wrongCode(code);
      const field = fieldOf(page);
      await field.pressSequentially(typed);
      await enterOf(page).click();
      await expect(field).toHaveAccessibleDescription(ES.invalid);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveValue(typed);
      await expect(page).toHaveURL(/\/es\/login$/);
      await expect(toasts(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  const answers: [string, string, string][] = [
    ["errors.codeTimeout", "our side did not answer", ES.timeout],
    ["errors.codeRateLimited", "Auth says too many tries", ES.tooMany],
    ["errors.codeInvalid", "Auth refused the code", ES.invalid],
  ];
  for (const [key, why, sentence] of answers) {
    test(`${key} (${why}) says its own sentence under the field`, async ({ browser, baseURL }) => {
      // Kills: rendering `codeInvalid` for every key; a toast instead of the field message.
      const { context, page } = await askForCode(browser, baseURL!);
      try {
        await answerActionWith(page, key);
        const field = fieldOf(page);
        await field.pressSequentially("123456");
        await enterOf(page).click();
        await expect(field).toHaveAccessibleDescription(sentence);
        await expect(field).toHaveValue("123456");
        await expect(toasts(page)).toHaveCount(0);
        await expect(enterOf(page)).toBeEnabled();
      } finally {
        await context.close();
      }
    });
  }

  test("done · first sign-in: the mailed code lands on the home page with the personal categories seeded in Spanish", async ({
    browser,
    baseURL,
  }) => {
    // Kills: the action skipping `landSession`.
    const { email, code, context, page } = await askForCode(browser, baseURL!);
    try {
      await fieldOf(page).pressSequentially(code);
      await enterOf(page).click();
      await expect(page).toHaveURL(/\/es$/);
      expect(await context.cookies()).toContainEqual(
        expect.objectContaining({ name: expect.stringMatching(/auth-token(?!.*code-verifier)/) }),
      );
      await page.goto("/es/movements");
      await expect(page).toHaveURL(/\/es\/movements$/);

      const seeded = await fixtureSql<{ name: string }[]>`
        select name from categories where owner_user_id = ${await userIdOf(email)}`;
      const expected = SEED_CATEGORIES.flatMap((category) => [
        category.name.es,
        ...(category.children ?? []).map((child) => child.name.es),
      ]);
      expect(seeded.map((row) => row.name).sort()).toEqual(expected.sort());
    } finally {
      await context.close();
    }
  });

  test("done · an address pending as a member lands on the home page and joins nothing", async ({
    browser,
    baseURL,
  }) => {
    // Kills: `landSession` claiming the pending invitation (RF-154: only accepting joins).
    const email = newAddress();
    await listAddress(email);
    claimedKeys.push(addressKey(email, SALT));
    const { groupId } = await seedGroup();
    const pendingId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into group_members (id, group_id, name, role, invite_email)
        values (${pendingId}, ${groupId}, ${`Invitado C6 ${stamp}`}, 'member', ${email})`;
    });
    const [before] = await fixtureSql<{ n: number }[]>`select count(*)::int as n from group_members where group_id = ${groupId}`;
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await page.goto("/es/login");
      await page.getByLabel(messages.auth.emailLabel).fill(email);
      await page.getByRole("button", { name: messages.auth.sendLink, exact: true }).click();
      await expect(page.getByRole("heading", { name: ES.title, exact: true })).toBeVisible();
      await register(email);

      await fieldOf(page).pressSequentially(await mailedCode(email));
      await enterOf(page).click();
      await expect(page).toHaveURL(/\/es$/);

      const [member] = await fixtureSql<{ id: string; name: string; user_id: string | null; invite_state: string; invite_email: string | null }[]>`
        select id, name, user_id, invite_state, invite_email from group_members where id = ${pendingId}`;
      expect(member).toEqual({
        id: pendingId,
        name: `Invitado C6 ${stamp}`,
        user_id: null,
        invite_state: "pending",
        invite_email: email,
      });
      const [after] = await fixtureSql<{ n: number }[]>`select count(*)::int as n from group_members where group_id = ${groupId}`;
      expect(after.n).toBe(before.n);
      const [memberships] = await fixtureSql<{ n: number }[]>`select count(*)::int as n from group_members where user_id = ${await userIdOf(email)}`;
      expect(memberships.n).toBe(0);
    } finally {
      await context.close();
      await clearGroup();
    }
  });

  test("done · the page asked for before signing in is where the code lands", async ({ browser, baseURL }) => {
    // Kills: the action ignoring `post_login_redirect`.
    const { code, context, page } = await askForCode(browser, baseURL!, { path: "/es/login?next=/es/movements" });
    try {
      await fieldOf(page).pressSequentially(code);
      await enterOf(page).click();
      // The whole URL: `/es/login?next=/es/movements` also ends in «/es/movements».
      await expect(page).toHaveURL(new URL("/es/movements", baseURL!).href);
    } finally {
      await context.close();
    }
  });

  test("done · a destination outside the app is ignored: the code lands on the home page", async ({ browser, baseURL }) => {
    // Kills: the redirect that follows any `next` it is given.
    const { code, context, page } = await askForCode(browser, baseURL!, { path: "/es/login?next=//evil.example/steal" });
    try {
      await fieldOf(page).pressSequentially(code);
      await enterOf(page).click();
      await expect(page).toHaveURL(/\/es$/);
      expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    } finally {
      await context.close();
    }
  });

  test("done · a spent code typed again in a second context is refused as a wrong one", async ({ browser, baseURL }) => {
    // Kills: `verifyCodeAction` landing on error; a code that verifies twice.
    const { code, context, page } = await askForCode(browser, baseURL!);
    let second: BrowserContext | undefined;
    try {
      // The same device, pending on the same send: its storage, taken before the code is typed.
      const pending = await context.storageState();
      const ip = newCaller();
      claimedKeys.push(callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!);
      second = await browser.newContext({ baseURL: baseURL!, storageState: pending, extraHTTPHeaders: { "x-forwarded-for": ip } });
      const again = await second.newPage();
      await again.goto("/es/login");
      await expect(fieldOf(again)).toBeVisible();

      await fieldOf(page).pressSequentially(code);
      await enterOf(page).click();
      await expect(page).toHaveURL(/\/es$/);

      await fieldOf(again).pressSequentially(code);
      await enterOf(again).click();
      await expect(fieldOf(again)).toHaveAccessibleDescription(ES.invalid);
      await expect(again).toHaveURL(/\/es\/login$/);
      await expect(toasts(again)).toHaveCount(0);
    } finally {
      await second?.close();
      await context.close();
    }
  });

  test("cancelled: «Usar otro correo» returns an empty email form in focus, and a reload stays on it", async ({
    browser,
    baseURL,
  }) => {
    // Kills: skipping the clear of the stored address.
    const { context, page } = await askForCode(browser, baseURL!);
    try {
      await expect(fieldOf(page)).toBeVisible();
      await anotherOf(page).click();
      const email = page.getByLabel(messages.auth.emailLabel);
      await expect(email).toBeVisible();
      await expect(email).toHaveValue("");
      await expect(email).toBeFocused();
      await page.reload();
      await settled(page);
      await expect(page.getByLabel(messages.auth.emailLabel)).toBeVisible();
      await expect(fieldOf(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("relaunch: the code step comes back with the same address for the code's hour, then the form", async ({ browser, baseURL }) => {
    // Kills: no read on mount; no expiry check. The clock is each page's own, the storage the context's.
    const { email, context, page } = await askForCode(browser, baseURL!);
    try {
      await page.close();

      const at5 = await context.newPage();
      await at5.clock.install({ time: new Date(Date.now() + 5 * 60_000) });
      await at5.goto("/es/login");
      await expect(at5.getByRole("heading", { name: ES.title, exact: true })).toBeVisible();
      await expect(at5.getByText(ES.description(email), { exact: true })).toBeVisible();
      await expect(fieldOf(at5)).toBeVisible();
      await at5.close();

      const at61 = await context.newPage();
      await at61.clock.install({ time: new Date(Date.now() + 61 * 60_000) });
      await at61.goto("/es/login");
      await settled(at61);
      await expect(at61.getByLabel(messages.auth.emailLabel)).toBeVisible();
      await expect(fieldOf(at61)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a landed code clears the pending address: signed out again, the login opens on the email form", async ({
    browser,
    baseURL,
  }) => {
    // Kills: a landed code that leaves the stored address behind.
    const { code, context, page } = await askForCode(browser, baseURL!);
    try {
      await fieldOf(page).pressSequentially(code);
      await enterOf(page).click();
      await expect(page).toHaveURL(/\/es$/);
      await context.clearCookies();
      await page.goto("/es/login");
      await settled(page);
      await expect(page.getByLabel(messages.auth.emailLabel)).toBeVisible();
      await expect(fieldOf(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("English: the sent state, the incomplete and the refused code read in English", async ({ browser, baseURL }) => {
    // Kills: a key missing from en.json.
    const { email, code, context, page } = await askForCode(browser, baseURL!, { locale: "en" });
    try {
      await expect(page.getByRole("heading", { name: EN.title, exact: true })).toBeVisible();
      await expect(page.getByText(EN.description(email), { exact: true })).toBeVisible();
      const field = fieldOf(page, EN.label);
      await expect(field).toBeVisible();

      await field.fill("12345");
      await enterOf(page, EN.enter).click();
      await expect(field).toHaveAccessibleDescription(EN.incomplete);

      await field.fill(wrongCode(code));
      await enterOf(page, EN.enter).click();
      await expect(field).toHaveAccessibleDescription(EN.invalid);
    } finally {
      await context.close();
    }
  });

  test("English: the login's hint and button", async ({ browser, baseURL }) => {
    // Kills: the old English values left in en.json.
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await page.goto("/en/login");
      await expect(page.getByText(EN.hint, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: EN.send, exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("the 360 face", () => {
  test.skip(({ viewport }) => viewport?.width !== 360, "the narrow face is read on the phone project");

  test("no horizontal overflow; the field and both buttons are at least 44 px tall", async ({ browser, baseURL }) => {
    // Kills: `size="1"` on the field; a button below the tap floor.
    const { context, page } = await askForCode(browser, baseURL!);
    try {
      await expect(fieldOf(page)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      for (const target of [fieldOf(page), enterOf(page), anotherOf(page)]) {
        const box = await target.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await context.close();
    }
  });
});

// Another code (board «LoginCódigoOtro»): the countdown is read on a paused clock that starts at the stored
// `sentAt`, so «60 s» and «30 s» are exact and no test waits a real minute.
const PENDING_KEY = "homefund.pending-sign-in";
const MARKER = "homefund-signed-in-at";
const resendOf = (page: Page, name = ES.resend) => page.getByRole("button", { name, exact: true });

async function storedSentAt(page: Page): Promise<number> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY);
  expect(raw, "the send left its record on the device").not.toBeNull();
  return (JSON.parse(raw!) as { sentAt: number }).sentAt;
}

// A relaunch of the installed app, `offsetMs` after the send, with the page's clock frozen there.
async function reopenAt(context: BrowserContext, path: string, sentAt: number, offsetMs: number): Promise<Page> {
  const page = await context.newPage();
  await page.clock.install({ time: sentAt + offsetMs - 1_000 });
  await page.clock.pauseAt(sentAt + offsetMs);
  await page.goto(path);
  return page;
}

// The code step of a send that has already happened, reopened on a frozen clock.
async function sentAndReopened(browser: Browser, baseURL: string, offsetMs: number, path = "/es/login") {
  const asked = await askForCode(browser, baseURL, { path });
  const sentAt = await storedSentAt(asked.page);
  await asked.page.close();
  const page = await reopenAt(asked.context, path, sentAt, offsetMs);
  await expect(fieldOf(page)).toBeVisible();
  return { ...asked, page, sentAt };
}

async function mailCount(email: string): Promise<number> {
  const found = (await (await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()) as {
    messages_count: number;
  };
  return found.messages_count;
}

async function waitForMails(email: string, count: number) {
  await expect.poll(() => mailCount(email)).toBe(count);
}

// A tap on «Pedir otro código» once it is ready: a button that never arrives fails here, not on a 30 s click.
async function tap(page: Page) {
  await expect(resendOf(page)).toBeEnabled();
  await resendOf(page).click();
}

test.describe("another code", () => {
  test.skip(({ viewport }) => viewport?.width === 360, "the states are read once, on the laptop");

  test("the wait is 60 s from the send: disabled at 60 s and at +59 s, ready at +60 s", async ({ browser, baseURL }) => {
    // Kills: RESEND_WAIT_MS = 0.
    const { context, page } = await sentAndReopened(browser, baseURL!, 0);
    try {
      const waiting = resendOf(page, ES.resendIn(60));
      await expect(waiting).toBeVisible();
      await expect(waiting).toBeDisabled();
      await page.clock.runFor(59_000);
      await expect(page.getByRole("button", { name: /^Pedir otro en \d+ s$/ })).toBeDisabled();
      await page.clock.runFor(1_000);
      await expect(resendOf(page)).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  test("a relaunch 30 s after the send resumes the wait at 30 s", async ({ browser, baseURL }) => {
    // Kills: counting from the mount instead of from the stored `sentAt`.
    const { context, page } = await sentAndReopened(browser, baseURL!, 30_000);
    try {
      await expect(resendOf(page, ES.resendIn(30))).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  test("pending: one send for the stored address; spinner and «Enviando otro código»; the rest disabled; a second tap sends nothing", async ({
    browser,
    baseURL,
  }) => {
    // Kills: no `disabled` while pending; «Usar otro correo» left enabled; a send to another address.
    const { email, context, page } = await sentAndReopened(browser, baseURL!, 60_000);
    try {
      const bodies: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      await page.route(ACTION_URL, async (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"]) {
          bodies.push(request.postData() ?? "");
          await held;
        }
        await route.continue();
      });
      await tap(page);

      const sending = resendOf(page, ES.resending);
      await expect(sending).toBeVisible();
      await expect(sending).toBeDisabled();
      await expect(sending.locator(".rt-Spinner")).toBeVisible();
      await expect(enterOf(page)).toBeDisabled();
      await expect(fieldOf(page)).toBeDisabled();
      await expect(anotherOf(page)).toBeDisabled();

      await sending.dispatchEvent("click");
      release();
      await expect(page.getByText(ES.resent(email), { exact: true })).toBeVisible();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain(email);
      await waitForMails(email, 2);
    } finally {
      await context.close();
    }
  });

  test("done: the status line names the address, the field is empty and focused, the wait is back at 60 s, the newest code lands", async ({
    browser,
    baseURL,
  }) => {
    // Kills: keeping the old code in the field; not restarting the wait; no status line.
    const { email, code: first, context, page } = await sentAndReopened(browser, baseURL!, 60_000);
    try {
      const field = fieldOf(page);
      await field.fill(wrongCode(first));
      await tap(page);
      await expect(page.getByText(ES.resent(email), { exact: true })).toBeVisible();
      await expect(field).toHaveValue("");
      await expect(field).toBeFocused();
      await expect(resendOf(page, ES.resendIn(60))).toBeDisabled();

      await waitForMails(email, 2);
      const newest = await mailedCode(email);
      await field.pressSequentially(newest);
      await enterOf(page).click();
      await expect(page).toHaveURL(/\/es$/);
    } finally {
      await context.close();
    }
  });

  test("a send the day's cap refuses: the toast in the new words, the button ready again, the wait not restarted", async ({
    browser,
    baseURL,
  }) => {
    // Kills: restarting the wait on error; the old «enlaces» words; a refused send that still stores a new `sentAt`.
    const { email, context, page } = await sentAndReopened(browser, baseURL!, 60_000);
    try {
      await tap(page);
      await waitForMails(email, 2);
      await expect(resendOf(page, ES.resendIn(60))).toBeDisabled();
      await page.clock.runFor(60_000);
      await expect(resendOf(page)).toBeEnabled();
      await tap(page);
      await waitForMails(email, 3);
      await expect(resendOf(page, ES.resendIn(60))).toBeDisabled();
      await page.clock.runFor(60_000);
      await expect(resendOf(page)).toBeEnabled();

      const before = await storedSentAt(page);
      await tap(page);
      // Sonner mounts a toast inside a setTimeout, which a paused clock never fires: tick until the answer has landed.
      await expect(async () => {
        await page.clock.runFor(1);
        await expect(toasts(page).filter({ hasText: ES.capped })).toBeVisible({ timeout: 250 });
      }).toPass();
      await expect(resendOf(page)).toBeEnabled();
      expect(await storedSentAt(page)).toBe(before);
      expect(await mailCount(email)).toBe(3);
    } finally {
      await context.close();
    }
  });

  test("the page asked for is kept: a resend from /login?next=… still lands there", async ({ browser, baseURL }) => {
    // Kills: binding `undefined` instead of `next` to the resend.
    const { email, context, page } = await sentAndReopened(browser, baseURL!, 60_000, "/es/login?next=/es/movements");
    try {
      await tap(page);
      await expect(page.getByText(ES.resent(email), { exact: true })).toBeVisible();
      await waitForMails(email, 2);
      await fieldOf(page).pressSequentially(await mailedCode(email));
      await enterOf(page).click();
      await expect(page).toHaveURL(new URL("/es/movements", baseURL!).href);
    } finally {
      await context.close();
    }
  });

  test("while the code is being checked the resend is disabled", async ({ browser, baseURL }) => {
    // Kills: a resend that ignores the verification in flight.
    const { code, context, page } = await sentAndReopened(browser, baseURL!, 60_000);
    try {
      await expect(resendOf(page)).toBeEnabled();
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      await answerActionWith(page, "errors.codeTimeout", held);
      await fieldOf(page).fill(code);
      await enterOf(page).click();
      await expect(page.getByRole("button", { name: ES.checking, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pedir otro/ })).toBeDisabled();
      release();
      await expect(resendOf(page)).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  test("a link that landed after the send clears the pending code: the login opens on the email form and the record is gone", async ({
    browser,
    baseURL,
  }) => {
    // Kills: ignoring the marker cookie.
    const { context, page } = await askForCode(browser, baseURL!);
    try {
      const sentAt = await storedSentAt(page);
      await context.addCookies([{ name: MARKER, value: String(sentAt + 5_000), url: baseURL! }]);
      await page.goto("/es/login");
      await settled(page);
      await expect(page.getByLabel(messages.auth.emailLabel)).toBeVisible();
      await expect(fieldOf(page)).toHaveCount(0);
      expect(await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("a marker older than the send does not clear it: the code step opens", async ({ browser, baseURL }) => {
    // Kills: comparing the marker the wrong way round.
    const { context, page } = await askForCode(browser, baseURL!);
    try {
      const sentAt = await storedSentAt(page);
      await context.addCookies([{ name: MARKER, value: String(sentAt - 60_000), url: baseURL! }]);
      await page.goto("/es/login");
      await expect(fieldOf(page)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("words: «código» in the page description and both toasts, never «enlace»; the old description is gone", () => {
    // Kills: leaving the link words in es.json or en.json; keeping `auth.loginDescription`.
    // The keys do not exist until the worker adds them, so the files are read as plain records.
    const esAuth = messages.auth as unknown as Record<string, string>;
    const enAuth = en.auth as unknown as Record<string, string>;
    expect(esAuth.resend).toBe(ES.resend);
    expect(esAuth.resendIn).toBe("Pedir otro en {seconds} s");
    expect(esAuth.resending).toBe(ES.resending);
    expect(esAuth.resent).toBe("Te mandamos otro código a {email}. Usa el del último correo.");
    expect(messages.errors.signInLinkCapped).toBe(ES.capped);
    expect(messages.errors.emailRateLimited).toBe("Pediste demasiados códigos seguidos. Espera un momento y vuelve a intentarlo.");
    expect(messages.metadata.loginDescription).toBe("Entra con un código enviado a tu correo, sin contraseña.");
    expect(enAuth.resend).toBe(EN.resend);
    expect(enAuth.resendIn).toBe("Ask again in {seconds} s");
    expect(enAuth.resending).toBe(EN.resending);
    expect(enAuth.resent).toBe("We sent another code to {email}. Use the one in the latest email.");
    expect(en.errors.signInLinkCapped).toBe(EN.capped);
    expect(en.errors.emailRateLimited).toBe(EN.rateLimited);
    expect(en.metadata.loginDescription).toBe("Sign in with a code sent to your email, no password needed.");
    for (const text of [messages.metadata.loginDescription, messages.errors.signInLinkCapped, messages.errors.emailRateLimited]) {
      expect(text).toContain("código");
      expect(text).not.toContain("enlace");
    }
    for (const text of [en.metadata.loginDescription, en.errors.signInLinkCapped, en.errors.emailRateLimited]) {
      expect(text).toContain("code");
      expect(text).not.toMatch(/link/i);
    }
    expect("loginDescription" in esAuth).toBe(false);
    expect("loginDescription" in enAuth).toBe(false);
  });
});
