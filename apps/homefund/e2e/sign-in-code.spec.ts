/**
 * Signing in with the six-digit code (RF-146): the step after «Revisa tu correo» (board «LoginCódigo»).
 *
 * Written from the contract and the board, not from `login-form.tsx`: every sentence the person reads
 * is spelled out here, so a changed value in `es.json` or `en.json` reddens a test; only the words
 * this slice leaves alone are read by key (`auth.sendLink` clicks the send button, whatever it says).
 *
 * The code is the one the local stack mailed: the spec reads it from mailpit (:44324) and types it
 * the way a person would. Nothing leaves the machine and the spec refuses any other stack; the
 * addresses end in `.invalid`. The answers «our side» and «too many» cannot be provoked on demand,
 * so the action's POST is answered by the browser with the reason the action would throw.
 *
 * Each address is registered under this worker's run the moment Auth has created it and dropped
 * after the file, as `sign-in.spec.ts` does.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { closeRun, openRun, runId } from "@repo/harness-registry";
import { expect, type Browser, type Page } from "@playwright/test";

import { addressKey, callerKey } from "@/lib/auth/client-key";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import en from "@/messages/en.json";
import messages from "@/messages/es.json";

import { fixtureSql, purgeAuditTrail, purgeIdentity } from "../scripts/harness/fixtures";
import { clearGroup, test } from "./global-setup";

const MAILBOX = "http://127.0.0.1:44324";
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
});

test.describe("the 360 face", () => {
  test.skip(({ viewport }) => viewport?.width !== 360, "the narrow face is read on the phone project");

  test("no horizontal overflow; the field and both buttons are at least 44 px tall @mobile", async ({ browser, baseURL }) => {
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
