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

  test("done · an address pending as a member lands on the welcome as that member, not as a new one", async ({
    browser,
    baseURL,
  }) => {
    // Kills: dropping `claimInviteForUser` from `landSession`.
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
      await expect(page).toHaveURL(/\/es\/bienvenida$/);

      const [member] = await fixtureSql<{ id: string; name: string; user_id: string | null }[]>`
        select id, name, user_id from group_members where id = ${pendingId}`;
      expect(member).toEqual({ id: pendingId, name: `Invitado C6 ${stamp}`, user_id: await userIdOf(email) });
      const [after] = await fixtureSql<{ n: number }[]>`select count(*)::int as n from group_members where group_id = ${groupId}`;
      expect(after.n).toBe(before.n);
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
