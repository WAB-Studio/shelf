/**
 * Passwordless sign-in end to end (RF-01), through the local stack's mailbox.
 *
 * Every send goes to the local Auth and lands in its mailpit (:54324); nothing
 * leaves the machine, and the spec refuses to run against any other stack. The
 * addresses end in `.invalid`, so even a leak could not be delivered.
 *
 * The link is opened the way the production template builds it: the route reads
 * `token_hash` and `type` (`app/auth/confirm/route.ts`), so the spec takes both
 * from the message the stack really sent: the verify URL in the mail carries the
 * hashed token as its `token` and the kind of link as its `type`, and the same
 * pair goes into `/auth/confirm?token_hash=…&type=…`.
 *
 * Each address is registered under this worker's run the moment Auth has
 * created it, and its rows are dropped after the file, so the census finds no
 * identity the registry does not know.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";

import { closeRun, openRun, runId } from "@repo/harness-registry";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { addressKey, callerKey } from "@/lib/auth/client-key";
import { todayInBogota } from "@/lib/dates";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import en from "@/messages/en.json";
import messages from "@/messages/es.json";

import { fixtureSql, purgeAuditTrail, purgeIdentity } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, seedGroup, test } from "./global-setup";

const auth = messages.auth;
const MAILBOX = "http://127.0.0.1:54324";
const signedOut = { cookies: [], origins: [] };

const stamp = randomUUID().slice(0, 8);
let serial = 0;
const minted: string[] = [];
const listedEmails: string[] = [];
const claimedKeys: string[] = [];

test.skip(({ viewport }) => viewport?.width === 360, "the sign-in facts are read once, on the laptop");

test.beforeAll(async ({ baseURL }) => {
  // Without the salt the caps are open (`noKey`) and every sign-in below would pass for the wrong reason.
  expect(process.env.CLIENT_KEY_SALT?.length ?? 0, "CLIENT_KEY_SALT must be set (>= 16 chars): this file fails, never skips").toBeGreaterThanOrEqual(16);
  // The send creates an `auth.users` row and a mail: only the local stack may receive either.
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
    // By exact address or key: another lane's rows are never reached.
    if (listedEmails.length) await fixtureSql`delete from finances.allowed_emails where email in ${fixtureSql(listedEmails)}`;
    if (claimedKeys.length) await fixtureSql`delete from finances.sign_in_claims where client_key in ${fixtureSql(claimedKeys)}`;
  } finally {
    await closeRun(fixtureSql);
  }
});

function newAddress(domain = "example.invalid"): string {
  serial += 1;
  const email = `harness-signin-${stamp}-${serial}@${domain}`;
  minted.push(email);
  return email;
}

const SALT = process.env.CLIENT_KEY_SALT ?? "";

// A random /64 in 2001:db8::/32 per caller: the caller counter is shared by every lane and rerun.
function newCaller(): string {
  const group = () => randomBytes(2).toString("hex");
  return `2001:db8:${group()}:${group()}:${group()}::1`;
}

// Lists the address by its exact value; the file removes it by that value after.
async function listAddress(email: string) {
  listedEmails.push(email);
  await fixtureSql`insert into finances.allowed_emails (email) values (${email.trim().toLowerCase()})`;
}

function track(ip: string, email: string) {
  claimedKeys.push(callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!, addressKey(email, SALT));
}

// What a refusal shows: the sentence once the catalogue has it, the key the action threw until then.
function refusalText(key: string): string {
  const name = key.replace(/^errors\./, "");
  return (messages.errors as Record<string, string>)[name] ?? key;
}

async function register(email: string) {
  await fixtureSql`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId()}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

// Every context is its own caller, so the daily caller cap never counts another row's sends.
async function fresh(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page; ip: string }> {
  const ip = newCaller();
  claimedKeys.push(callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!);
  const context = await browser.newContext({ baseURL, storageState: signedOut, extraHTTPHeaders: { "x-forwarded-for": ip } });
  return { context, page: await context.newPage(), ip };
}

async function requestLink(page: Page, email: string, path = "/es/login") {
  claimedKeys.push(addressKey(email, SALT));
  await page.goto(path);
  await page.getByLabel(auth.emailLabel).fill(email);
  await page.getByRole("button", { name: auth.sendLink, exact: true }).click();
  await expect(page.getByRole("heading", { name: auth.sentTitle, exact: true })).toBeVisible();
  await register(email);
}

async function inbox(email: string) {
  const response = await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  return (await response.json()) as { messages_count: number; messages: { ID: string }[] };
}

// The link the stack's message carries, rebuilt as the route reads it.
async function confirmPath(email: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      id = (await inbox(email)).messages[0]?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json();
  const href = /https?:\/\/[^"'\s<>]*\/auth\/v1\/verify\?[^"'\s<>]+/.exec(`${message.HTML}\n${message.Text}`)?.[0];
  if (!href) throw new Error("the mail carries no verify link");
  const verify = new URL(href.replaceAll("&amp;", "&"));
  const token = verify.searchParams.get("token");
  const type = verify.searchParams.get("type");
  if (!token || !type) throw new Error(`the verify link has no token or type: ${href}`);
  return `/auth/confirm?token_hash=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`;
}

async function userIdOf(email: string): Promise<string> {
  const [row] = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  return row.id;
}

test("the login form sends one message to the address and says so", async ({ browser, baseURL }) => {
  // Kills: the sign-in action that answers «Revisa tu correo» without asking Auth to send.
  const email = newAddress();
  await listAddress(email);
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email);
    await expect(page.getByText(email, { exact: false })).toBeVisible();

    await expect.poll(async () => (await inbox(email)).messages_count).toBe(1);
  } finally {
    await context.close();
  }
});

test("opening the link signs the person in on the app, with the personal categories seeded in Spanish", async ({
  browser,
  baseURL,
}) => {
  // Kills: the first sign-in that skips the seed of the personal category set (RF-64).
  const email = newAddress();
  await listAddress(email);
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email);
    await page.goto(await confirmPath(email));

    await expect(page).toHaveURL(/\/es$/);
    expect(await context.cookies()).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/auth-token/) }));
    // Signed in: a page behind the login stays where it is.
    await page.goto("/es/movements");
    await expect(page).toHaveURL(/\/es\/movements$/);

    const userId = await userIdOf(email);
    const seeded = await fixtureSql<{ name: string }[]>`
      select name from categories where owner_user_id = ${userId}`;
    const expected = SEED_CATEGORIES.flatMap((category) => [
      category.name.es,
      ...(category.children ?? []).map((child) => child.name.es),
    ]);
    expect(seeded.map((row) => row.name).sort()).toEqual(expected.sort());
  } finally {
    await context.close();
  }
});

test("an address pending as a member signs in and lands as that member, not as a new one", async ({
  browser,
  baseURL,
}) => {
  // Kills: the sign-in that never claims the invitation (RF-06), so the person lands in no fund.
  const email = newAddress();
  await listAddress(email);
  const { groupId } = await seedGroup();
  const pendingId = randomUUID();
  await asHarnessUser(async (tx) => {
    await tx`
      insert into group_members (id, group_id, name, role, invite_email)
      values (${pendingId}, ${groupId}, ${`Invitado E9 ${stamp}`}, 'member', ${email})`;
  });
  const [before] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from group_members where group_id = ${groupId}`;

  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email);
    await page.goto(await confirmPath(email));

    await expect(page).toHaveURL(/\/es\/bienvenida$/);

    const userId = await userIdOf(email);
    const [member] = await fixtureSql<{ id: string; name: string; user_id: string | null }[]>`
      select id, name, user_id from group_members where id = ${pendingId}`;
    expect(member).toEqual({ id: pendingId, name: `Invitado E9 ${stamp}`, user_id: userId });
    const [after] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from group_members where group_id = ${groupId}`;
    expect(after.n).toBe(before.n);
  } finally {
    await context.close();
    await clearGroup();
  }
});

test("the page asked for before signing in is where the link lands", async ({ browser, baseURL }) => {
  // Kills: the destination dropped between the login form and the link.
  const email = newAddress();
  await listAddress(email);
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await page.goto("/es/movements");
    await expect(page).toHaveURL(/\/es\/login\?next=/);
    claimedKeys.push(addressKey(email, SALT));
    await page.getByLabel(auth.emailLabel).fill(email);
    await page.getByRole("button", { name: auth.sendLink, exact: true }).click();
    await expect(page.getByRole("heading", { name: auth.sentTitle, exact: true })).toBeVisible();
    await register(email);

    await page.goto(await confirmPath(email));
    await expect(page).toHaveURL(/\/es\/movements$/);
  } finally {
    await context.close();
  }
});

test("a destination outside the app is ignored: the link lands on the home page", async ({ browser, baseURL }) => {
  // Kills: the redirect that follows any `next` it is given.
  const email = newAddress();
  await listAddress(email);
  const { context, page } = await fresh(browser, baseURL!);
  try {
    await requestLink(page, email, "/es/login?next=//evil.example/steal");
    await page.goto(await confirmPath(email));

    await expect(page).toHaveURL(/\/es$/);
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  } finally {
    await context.close();
  }
});

test("a link opened a second time lands on the login with the invalid-link notice", async ({ browser, baseURL }) => {
  // Kills: the route that treats a spent link as a good one.
  const email = newAddress();
  await listAddress(email);
  const first = await fresh(browser, baseURL!);
  const second = await fresh(browser, baseURL!);
  try {
    await requestLink(first.page, email);
    const path = await confirmPath(email);

    await first.page.goto(path);
    await expect(first.page).toHaveURL(/\/es$/);

    await second.page.goto(path);
    await expect(second.page).toHaveURL(/\/es\/login\?error=linkInvalid$/);
    await expect(second.page.getByText(messages.errors.linkInvalid, { exact: true })).toBeVisible();
    expect(await second.context.cookies()).not.toContainEqual(
      expect.objectContaining({ name: expect.stringMatching(/auth-token/) }),
    );
  } finally {
    await first.context.close();
    await second.context.close();
  }
});

test("every address this file minted is in the harness registry under this run", async () => {
  // Kills: an identity left out of the registry, which the census would count as a leak.
  expect(minted.length).toBeGreaterThan(0);
  const rows = await fixtureSql<{ email: string; run_id: string | null; disposition: string }[]>`
    select u.email, i.run_id, i.disposition
    from auth.users u
    left join harness.identities i on i.user_id = u.id
    where u.email like ${`harness-signin-${stamp}-%`}`;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row, row.email).toMatchObject({ run_id: runId(), disposition: "ephemeral" });
  }
});

// RF-145 and RF-143: the list and the daily caps answer before any mail is sent.
const CLIENT_CAP = Number(process.env.SIGN_IN_LINK_DAILY_CLIENT_CAP ?? 10);
const ADDRESS_CAP = Number(process.env.SIGN_IN_LINK_DAILY_ADDRESS_CAP ?? 3);

type Attempt = { kind: "sent"; panel: string } | { kind: "refused"; text: string };

// Submits the form as `ip` and reports which of the two answers the person saw.
async function attempt(browser: Browser, baseURL: string, ip: string, typed: string): Promise<Attempt> {
  const context = await browser.newContext({ baseURL, storageState: signedOut, extraHTTPHeaders: { "x-forwarded-for": ip } });
  try {
    const page = await context.newPage();
    await page.goto("/es/login");
    await page.getByLabel(auth.emailLabel).fill(typed);
    await page.getByRole("button", { name: auth.sendLink, exact: true }).click();
    const sent = page.getByRole("heading", { name: auth.sentTitle, exact: true });
    const toast = page.locator("[data-sonner-toast][data-type='error']");
    await expect(sent.or(toast)).toBeVisible();
    if (await sent.isVisible()) {
      await register(typed.trim().toLowerCase());
      return { kind: "sent", panel: await page.getByRole("status").innerText() };
    }
    // A refusal says so; «unexpected» is a crash, not a refusal.
    await expect(toast).not.toContainText(messages.errors.unexpected);
    return { kind: "refused", text: await toast.innerText() };
  } finally {
    await context.close();
  }
}

async function submit(browser: Browser, baseURL: string, ip: string, typed: string): Promise<"sent" | "refused"> {
  return (await attempt(browser, baseURL, ip, typed)).kind;
}

async function claimsOf(keys: string[]): Promise<number> {
  const rows = await fixtureSql`select 1 from finances.sign_in_claims where client_key in ${fixtureSql(keys)}`;
  return rows.length;
}

test.describe("the list and the daily caps", () => {
  test("a listed address gets its link whatever the case or the padding typed", async ({ browser, baseURL }) => {
    // Kills: drop lower(btrim()) from the lookup.
    const email = newAddress();
    await listAddress(email);
    const ip = newCaller();
    track(ip, email);

    expect(await submit(browser, baseURL!, ip, ` ${email.toUpperCase()} `)).toBe("sent");
    await expect.poll(async () => (await inbox(email)).messages_count).toBe(1);
    // The send went through the claims: the address spent one of its three.
    const spent = await fixtureSql<{ count: number }[]>`
      select count from finances.sign_in_claims where client_key = ${addressKey(email, SALT)}`;
    expect(spent.map((row) => row.count)).toEqual([1]);
  });

  test("an address that is not listed is refused with a toast and no mail", async ({ browser, baseURL }) => {
    // Kills: exists -> true.
    const email = newAddress();
    const ip = newCaller();
    track(ip, email);

    expect(await submit(browser, baseURL!, ip, email)).toBe("refused");
    expect((await inbox(email)).messages_count).toBe(0);
    const users = await fixtureSql`select 1 from auth.users where email = ${email}`;
    expect(users).toHaveLength(0);
  });

  test("one address takes three links a day from any callers; the fourth is refused", async ({ browser, baseURL }) => {
    // Kills: `<` -> `<=`; skipping the address claim; mapping `rateLimited` to a sent link.
    const email = newAddress();
    await listAddress(email);
    const results: Attempt[] = [];
    for (let i = 0; i <= ADDRESS_CAP; i += 1) {
      const ip = newCaller();
      track(ip, email);
      // Auth itself refuses a second link to one user inside its own interval (1 s locally);
      // the cap under test is the app's, so the sends are spaced past it.
      if (i > 0) await new Promise((done) => setTimeout(done, 2_000));
      results.push(await attempt(browser, baseURL!, ip, email));
    }
    expect(results.map((result) => result.kind)).toEqual([...Array(ADDRESS_CAP).fill("sent"), "refused"]);
    const refusal = results[ADDRESS_CAP];
    expect(refusal.kind === "refused" && refusal.text).toContain(refusalText("errors.signInLinkCapped"));
    // The refused fourth sent nothing.
    await expect.poll(async () => (await inbox(email)).messages_count).toBe(ADDRESS_CAP);
  });

  test.describe.serial("one caller", () => {
    const ip = newCaller();
    const targets: string[] = [];
    let last: Attempt | undefined;

    test("takes ten links a day to different addresses; the eleventh is refused", async ({ browser, baseURL }) => {
      // Kills: skipping the caller claim; `<` -> `<=`; mapping `rateLimited` to a sent link.
      const outcomes: string[] = [];
      for (let i = 0; i <= CLIENT_CAP; i += 1) {
        const email = newAddress();
        await listAddress(email);
        track(ip, email);
        targets.push(email);
        last = await attempt(browser, baseURL!, ip, email);
        outcomes.push(last.kind);
      }
      expect(outcomes).toEqual([...Array(CLIENT_CAP).fill("sent"), "refused"]);
      expect(last?.kind === "refused" && last.text).toContain(refusalText("errors.signInLinkCapped"));
      expect((await inbox(targets[CLIENT_CAP])).messages_count).toBe(0);
    });

    test("a caller refused at its cap spends nothing of the address it asked for", async () => {
      // Kills: claiming the address before the caller.
      expect(targets).toHaveLength(CLIENT_CAP + 1);
      const refused = targets[CLIENT_CAP];
      const rows = await fixtureSql`
        select 1 from finances.sign_in_claims where client_key = ${addressKey(refused, SALT)}`;
      expect(rows).toHaveLength(0);
      const spent = await fixtureSql<{ count: number }[]>`
        select count from finances.sign_in_claims where client_key = ${callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!}`;
      expect(spent.map((row) => row.count)).toEqual([CLIENT_CAP]);
    });
  });

  test("the claims are dated by Bogotá's day", async ({ browser, baseURL }) => {
    // Kills: `current_date` (red at 19:00-24:00 Bogotá here; any hour in scripts/check-sign-in.ts).
    const email = newAddress();
    await listAddress(email);
    const ip = newCaller();
    track(ip, email);
    expect(await submit(browser, baseURL!, ip, email)).toBe("sent");

    const keys = [callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!, addressKey(email, SALT)];
    const rows = await fixtureSql<{ day: string }[]>`
      select day::text as day from finances.sign_in_claims where client_key in ${fixtureSql(keys)}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.day).toBe(todayInBogota());
  });
});

test.describe("the sign-in action's refusals come before Auth is asked", () => {
  test("an uninvited address on a deliverable domain is refused with errors.notInvited and gets no mail", async ({
    browser,
    baseURL,
  }) => {
    // Kills: the list check after `signInWithOtp`.
    const email = newAddress("gmail.com");
    const ip = newCaller();
    track(ip, email);

    const result = await attempt(browser, baseURL!, ip, email);
    expect(result).toEqual({ kind: "refused", text: expect.stringContaining(refusalText("errors.notInvited")) });
    expect((await inbox(email)).messages_count).toBe(0);
    expect(await fixtureSql`select 1 from auth.users where email = ${email}`).toHaveLength(0);
    // A refusal spends no link of the caller's or the address's.
    expect(await claimsOf([callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!, addressKey(email, SALT)])).toBe(0);
  });

  test("an uninvited address on an undeliverable domain is told it is not invited: the list answers before DNS", async ({
    browser,
    baseURL,
  }) => {
    // Kills: the deliverability guard placed before the list.
    const email = newAddress("example.com");
    const ip = newCaller();
    track(ip, email);

    const result = await attempt(browser, baseURL!, ip, email);
    expect(result).toEqual({ kind: "refused", text: expect.stringContaining(refusalText("errors.notInvited")) });
    expect((await inbox(email)).messages_count).toBe(0);
  });

  test("a listed address on a domain that takes no mail is refused with errors.domainUndeliverable before Auth", async ({
    browser,
    baseURL,
  }) => {
    // Kills: dropping the `isDomainDeliverable` call; placing the claims before it.
    const email = newAddress("example.com");
    await listAddress(email);
    const ip = newCaller();
    track(ip, email);

    const result = await attempt(browser, baseURL!, ip, email);
    expect(result).toEqual({ kind: "refused", text: expect.stringContaining(refusalText("errors.domainUndeliverable")) });
    expect((await inbox(email)).messages_count).toBe(0);
    expect(await fixtureSql`select 1 from auth.users where email = ${email}`).toHaveLength(0);
    expect(await claimsOf([callerKey(new Headers({ "x-forwarded-for": ip }), SALT)!, addressKey(email, SALT)])).toBe(0);
  });

  test("a listed .invalid address reaches the local mailbox: the guard exempts the reserved TLD", async ({
    browser,
    baseURL,
  }) => {
    // Kills: `isDomainDeliverable` without the `.invalid` exemption (no MX, no A: it would refuse).
    const email = newAddress(`${stamp}.invalid`);
    await listAddress(email);
    const ip = newCaller();
    track(ip, email);

    expect((await attempt(browser, baseURL!, ip, email)).kind).toBe("sent");
    await expect.poll(async () => (await inbox(email)).messages_count).toBe(1);
  });

  test("a new address and a known one get the same answer", async ({ browser, baseURL }) => {
    // Kills: a sent panel (or a refusal) that differs for an address Auth had not met.
    const email = newAddress();
    await listAddress(email);
    expect(await fixtureSql`select 1 from auth.users where email = ${email}`).toHaveLength(0);

    const first = await attempt(browser, baseURL!, newCaller(), email);
    expect(await fixtureSql`select 1 from auth.users where email = ${email}`).toHaveLength(1);
    // Past Auth's own one-second interval for a user.
    await new Promise((done) => setTimeout(done, 2_000));
    const second = await attempt(browser, baseURL!, newCaller(), email);

    expect(first.kind).toBe("sent");
    expect(second).toEqual(first);
  });
});

// The link as the stack's mail carries it. Auth's own hop is made here, without a browser, so the
// test holds the `/auth/confirm?code=…` URL the person's browser would be sent to.
async function verifyUrlOf(email: string): Promise<URL> {
  let id = "";
  await expect
    .poll(async () => {
      id = (await inbox(email)).messages[0]?.ID ?? "";
      return id;
    })
    .not.toBe("");
  const message = await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json();
  const href = /https?:\/\/[^"'\s<>]*\/auth\/v1\/verify\?[^"'\s<>]+/.exec(`${message.HTML}\n${message.Text}`)?.[0];
  if (!href) throw new Error("the mail carries no verify link");
  return new URL(href.replaceAll("&amp;", "&"));
}

async function codeLinkOf(email: string, baseURL: string): Promise<{ url: string; code: string }> {
  const hop = await fetch(await verifyUrlOf(email), { redirect: "manual" });
  const location = hop.headers.get("location");
  if (!location) throw new Error(`Auth answered ${hop.status} with no redirect`);
  const target = new URL(location);
  const code = target.searchParams.get("code");
  if (!code) throw new Error(`Auth's redirect carries no code: ${location}`);
  expect(target.origin, "Auth redirects to the app").toBe(new URL(baseURL).origin);
  expect(target.pathname).toBe("/auth/confirm");
  return { url: target.toString(), code };
}

async function flowStates(code: string): Promise<number> {
  const rows = await fixtureSql`select 1 from auth.flow_state where auth_code = ${code}`;
  return rows.length;
}

function hasSession(cookies: { name: string }[]): boolean {
  // The PKCE verifier is named `…-auth-token-code-verifier`: it is not a session.
  return cookies.some(({ name }) => /auth-token/.test(name) && !name.endsWith("-code-verifier"));
}

test.describe("the code link lands only in the browser that asked", () => {
  test("opened in the asking browser it signs in, seeds the personal categories and sets the locale", async ({
    browser,
    baseURL,
  }) => {
    // Kills: dropping the `code` branch of the route.
    const email = newAddress();
    await listAddress(email);
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await requestLink(page, email);
      const link = await codeLinkOf(email, baseURL!);
      await page.goto(link.url);

      await expect(page).toHaveURL(/\/es$/);
      const cookies = await context.cookies();
      expect(hasSession(cookies)).toBe(true);
      expect(cookies).toContainEqual(expect.objectContaining({ name: "NEXT_LOCALE", value: "es" }));
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

  test("the page asked for before signing in is where the code link lands", async ({ browser, baseURL }) => {
    // Kills: reading `post_login_redirect` on the `token_hash` path only.
    const email = newAddress();
    await listAddress(email);
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await requestLink(page, email, "/es/login?next=/es/movements");
      await page.goto((await codeLinkOf(email, baseURL!)).url);
      await expect(page).toHaveURL(/\/es\/movements$/);
    } finally {
      await context.close();
    }
  });

  test("a pending member who signs in by code lands as that member, not as a new one", async ({ browser, baseURL }) => {
    // Kills: skipping `claimInviteForUser` on the `code` path.
    const email = newAddress();
    await listAddress(email);
    const { groupId } = await seedGroup();
    const pendingId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into group_members (id, group_id, name, role, invite_email)
        values (${pendingId}, ${groupId}, ${`Invitado M9 ${stamp}`}, 'member', ${email})`;
    });
    const [before] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from group_members where group_id = ${groupId}`;

    const { context, page } = await fresh(browser, baseURL!);
    try {
      await requestLink(page, email);
      await page.goto((await codeLinkOf(email, baseURL!)).url);
      await expect(page).toHaveURL(/\/es\/bienvenida$/);

      const [member] = await fixtureSql<{ id: string; name: string; user_id: string | null }[]>`
        select id, name, user_id from group_members where id = ${pendingId}`;
      expect(member).toEqual({ id: pendingId, name: `Invitado M9 ${stamp}`, user_id: await userIdOf(email) });
      const [after] = await fixtureSql<{ n: number }[]>`
        select count(*)::int as n from group_members where group_id = ${groupId}`;
      expect(after.n).toBe(before.n);
    } finally {
      await context.close();
      await clearGroup();
    }
  });

  test("opened in another browser it lands on the login with linkOtherBrowser and leaves the link unspent", async ({
    browser,
    baseURL,
  }) => {
    // Kills: asking Auth for the session without checking the browser holds the verifier.
    const email = newAddress();
    await listAddress(email);
    const asking = await fresh(browser, baseURL!);
    const other = await fresh(browser, baseURL!);
    try {
      await requestLink(asking.page, email);
      const link = await codeLinkOf(email, baseURL!);
      expect(await flowStates(link.code), "Auth minted the code").toBe(1);

      await other.page.goto(link.url);
      await expect(other.page).toHaveURL(/\/es\/login\?error=linkOtherBrowser$/);
      expect(hasSession(await other.context.cookies())).toBe(false);
      // Auth was not asked: its code is still there, and the browser that asked can still use it.
      expect(await flowStates(link.code)).toBe(1);

      await asking.page.goto(link.url);
      await expect(asking.page).toHaveURL(/\/es$/);
      expect(hasSession(await asking.context.cookies())).toBe(true);
    } finally {
      await asking.context.close();
      await other.context.close();
    }
  });

  test("a code opened a second time lands on the login with linkInvalid", async ({ browser, baseURL }) => {
    // Kills: redirecting to the home page on any Auth failure.
    const email = newAddress();
    await listAddress(email);
    const first = await fresh(browser, baseURL!);
    const second = await fresh(browser, baseURL!);
    try {
      await requestLink(first.page, email);
      const link = await codeLinkOf(email, baseURL!);
      // The second visit is from a browser that still holds the verifier, so only the spent code is wrong.
      const verifiers = (await first.context.cookies()).filter(({ name }) => name.endsWith("-code-verifier"));
      expect(verifiers.length, "the asking browser holds the verifier").toBeGreaterThan(0);

      await first.page.goto(link.url);
      await expect(first.page).toHaveURL(/\/es$/);

      await second.context.addCookies(verifiers);
      await second.page.goto(link.url);
      await expect(second.page).toHaveURL(/\/es\/login\?error=linkInvalid$/);
      expect(hasSession(await second.context.cookies())).toBe(false);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test("the redirect that lands either link says no-store", async ({ browser, baseURL }) => {
    // Kills: dropping `applyHeaders` on one path.
    const byCode = newAddress();
    const byHash = newAddress();
    await listAddress(byCode);
    await listAddress(byHash);
    const a = await fresh(browser, baseURL!);
    const b = await fresh(browser, baseURL!);
    try {
      await requestLink(a.page, byCode);
      const codeResponse = await a.context.request.get((await codeLinkOf(byCode, baseURL!)).url, { maxRedirects: 0 });
      expect([302, 307]).toContain(codeResponse.status());
      expect(codeResponse.headers()["cache-control"]).toContain("no-store");

      await requestLink(b.page, byHash);
      const hashResponse = await b.context.request.get(await confirmPath(byHash), { maxRedirects: 0 });
      expect([302, 307]).toContain(hashResponse.status());
      expect(hashResponse.headers()["cache-control"]).toContain("no-store");
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
});

// RF-145, RF-143: the login says each refusal and the other-browser notice in the person's words.
test.describe("the login's words", () => {
  const toastOf = (page: Page) => page.locator("[data-sonner-toast][data-type='error']");

  async function typeAndSend(page: Page, email: string, copy: typeof messages.auth = auth) {
    await page.getByLabel(copy.emailLabel).fill(email);
    await page.getByRole("button", { name: copy.sendLink, exact: true }).click();
  }

  test("pending: the button reads sending and is disabled until the answer", async ({ browser, baseURL }) => {
    // Kills: dropping `disabled={isPending}`.
    const email = newAddress();
    await listAddress(email);
    const { context, page, ip } = await fresh(browser, baseURL!);
    track(ip, email);
    try {
      await page.route("**/es/login", async (route) => {
        if (route.request().method() === "POST") await new Promise((done) => setTimeout(done, 1_500));
        await route.continue();
      });
      await page.goto("/es/login");
      await typeAndSend(page, email);
      const pending = page.getByRole("button", { name: auth.sending, exact: true });
      await expect(pending).toBeVisible();
      await expect(pending).toBeDisabled();
      await expect(page.getByRole("heading", { name: auth.sentTitle, exact: true })).toBeVisible();
      await register(email);
    } finally {
      await context.close();
    }
  });

  test("refused as not invited: the toast is errors.notInvited, the field keeps the address and the button is enabled", async ({
    browser,
    baseURL,
  }) => {
    // Kills: a wrong key; `form.reset()` on error.
    const email = newAddress("gmail.com");
    const { context, page, ip } = await fresh(browser, baseURL!);
    track(ip, email);
    try {
      await page.goto("/es/login");
      await typeAndSend(page, email);
      await expect(toastOf(page)).toHaveText(messages.errors.notInvited);
      await expect(page.getByLabel(auth.emailLabel)).toHaveValue(email);
      await expect(page.getByRole("button", { name: auth.sendLink, exact: true })).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  test("refused as undeliverable: the toast is errors.domainUndeliverable", async ({ browser, baseURL }) => {
    const email = newAddress("example.com");
    await listAddress(email);
    const { context, page, ip } = await fresh(browser, baseURL!);
    track(ip, email);
    try {
      await page.goto("/es/login");
      await typeAndSend(page, email);
      await expect(toastOf(page)).toHaveText(messages.errors.domainUndeliverable);
    } finally {
      await context.close();
    }
  });

  test("refused as capped: the toast is errors.signInLinkCapped, not the rate-limit sentence", async ({ browser, baseURL }) => {
    // Kills: reusing `errors.emailRateLimited`.
    const email = newAddress();
    await listAddress(email);
    for (let i = 0; i < ADDRESS_CAP; i += 1) {
      const ip = newCaller();
      track(ip, email);
      if (i > 0) await new Promise((done) => setTimeout(done, 2_000));
      expect((await attempt(browser, baseURL!, ip, email)).kind).toBe("sent");
    }
    await new Promise((done) => setTimeout(done, 2_000));
    const { context, page, ip } = await fresh(browser, baseURL!);
    track(ip, email);
    try {
      await page.goto("/es/login");
      await typeAndSend(page, email);
      await expect(toastOf(page)).toHaveText(messages.errors.signInLinkCapped);
      expect(messages.errors.signInLinkCapped).not.toBe(messages.errors.emailRateLimited);
    } finally {
      await context.close();
    }
  });

  test("done and cancelled: the panel names the address and «Usar otro correo» returns an empty form", async ({ browser, baseURL }) => {
    const email = newAddress();
    await listAddress(email);
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await requestLink(page, email);
      await expect(page.getByRole("status")).toContainText(email);
      await page.getByRole("button", { name: auth.useAnotherEmail, exact: true }).click();
      await expect(page.getByLabel(auth.emailLabel)).toHaveValue("");
    } finally {
      await context.close();
    }
  });

  test("other browser: linkOtherBrowser shows the red alert, linkInvalid its own, an unknown value none", async ({ browser, baseURL }) => {
    // Kills: testing only `linkInvalid`.
    const { context, page } = await fresh(browser, baseURL!);
    try {
      const alert = page.locator("main").getByRole("alert");
      await page.goto("/es/login?error=linkOtherBrowser");
      await expect(alert).toHaveText(messages.errors.linkOtherBrowser);
      await page.goto("/es/login?error=linkInvalid");
      await expect(alert).toHaveText(messages.errors.linkInvalid);
      await page.goto("/es/login?error=x");
      await expect(page.getByLabel(auth.emailLabel)).toBeVisible();
      await expect(alert).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("English: the four keys exist and render under /en/login", async ({ browser, baseURL }) => {
    // Kills: a key missing in en.json.
    for (const key of ["notInvited", "domainUndeliverable", "signInLinkCapped", "linkOtherBrowser"] as const) {
      expect(en.errors[key], key).toBeTruthy();
    }
    const email = newAddress("gmail.com");
    const { context, page, ip } = await fresh(browser, baseURL!);
    track(ip, email);
    try {
      await page.goto("/en/login?error=linkOtherBrowser");
      await expect(page.locator("main").getByRole("alert")).toHaveText(en.errors.linkOtherBrowser);
      await typeAndSend(page, email, en.auth);
      await expect(toastOf(page)).toHaveText(en.errors.notInvited);
    } finally {
      await context.close();
    }
  });
});

// RF-01, a link that Auth could not judge or that landed on a failure of ours: the person is told to open
// the link again, never that it is invalid, and never meets a bare 500.
const LINK_TIMEOUT_LINE = "No pudimos comprobar el enlace. Ábrelo otra vez desde el correo.";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test.describe("the link's landing when the answer is a timeout or the landing fails", () => {
  let stalled: ChildProcess | undefined;
  let stalledOrigin = "";

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const port = await freePort();
    stalledOrigin = `http://127.0.0.1:${port}`;
    stalled = spawn(
      process.execPath,
      [path.resolve(process.cwd(), "../../node_modules/next/dist/bin/next"), "start", "-p", String(port)],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: `--require ${path.resolve(process.cwd(), "e2e/support/stall-auth.cjs")}` },
        stdio: "ignore",
      },
    );
    await expect
      .poll(async () => (await fetch(`${stalledOrigin}/es/login`).catch(() => null))?.status ?? 0, { timeout: 90_000 })
      .toBe(200);
  });

  test.afterAll(() => {
    stalled?.kill("SIGTERM");
  });

  test("the login says to open the link again, in Spanish and in English", async ({ browser, baseURL }) => {
    // Kills: a login that does not know `linkTimeout`, and a catalogue without its line.
    expect((messages.errors as Record<string, string>).linkTimeout).toBe(LINK_TIMEOUT_LINE);
    expect((en.errors as Record<string, string>).linkTimeout?.length ?? 0).toBeGreaterThan(0);
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await page.goto("/es/login?error=linkTimeout");
      await expect(page.locator("main").getByRole("alert")).toHaveText(LINK_TIMEOUT_LINE);
      await expect(page.locator("main").getByRole("alert")).not.toHaveText(messages.errors.linkInvalid);
      await page.goto("/en/login?error=linkTimeout");
      await expect(page.locator("main").getByRole("alert")).toHaveText((en.errors as Record<string, string>).linkTimeout);
    } finally {
      await context.close();
    }
  });

  for (const [how, token] of [
    ["answers 504", "stall-504"],
    ["is unreachable", "stall-refused"],
  ] as const) {
    test(`Auth ${how}: the link lands on the login with linkTimeout and its line, not linkInvalid`, async ({ browser }) => {
      // Kills: a route that maps every Auth error to linkInvalid.
      const { context, page } = await fresh(browser, stalledOrigin);
      try {
        const answer = await page.request.get(`/auth/confirm?token_hash=${token}-${stamp}&type=magiclink`, { maxRedirects: 0 });
        expect(answer.status()).toBeGreaterThanOrEqual(300);
        expect(answer.status()).toBeLessThan(400);
        expect(new URL(answer.headers().location!).pathname + new URL(answer.headers().location!).search).toBe(
          "/es/login?error=linkTimeout",
        );

        await page.goto(`/auth/confirm?token_hash=${token}-${stamp}&type=magiclink`);
        await expect(page).toHaveURL(/\/es\/login\?error=linkTimeout$/);
        await expect(page.locator("main").getByRole("alert")).toHaveText(LINK_TIMEOUT_LINE);
        expect(await context.cookies()).not.toContainEqual(
          expect.objectContaining({ name: expect.stringMatching(/auth-token/) }),
        );
      } finally {
        await context.close();
      }
    });
  }

  test("a link Auth rejects, on the server that stalls other tokens, still lands on linkInvalid", async ({ browser }) => {
    // Kills: a route that sends every failure to linkTimeout.
    const { context, page } = await fresh(browser, stalledOrigin);
    try {
      await page.goto(`/auth/confirm?token_hash=${randomBytes(16).toString("hex")}&type=magiclink`);
      await expect(page).toHaveURL(/\/es\/login\?error=linkInvalid$/);
      await expect(page.locator("main").getByRole("alert")).toHaveText(messages.errors.linkInvalid);
    } finally {
      await context.close();
    }
  });

  test("an invalid hash lands on the login with linkInvalid and its line", async ({ browser, baseURL }) => {
    // Kills: a timeout split that sends a rejection Auth completed to linkTimeout.
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await page.goto(`/auth/confirm?token_hash=${randomBytes(16).toString("hex")}&type=magiclink`);
      await expect(page).toHaveURL(/\/es\/login\?error=linkInvalid$/);
      await expect(page.locator("main").getByRole("alert")).toHaveText(messages.errors.linkInvalid);
      expect(await context.cookies()).not.toContainEqual(
        expect.objectContaining({ name: expect.stringMatching(/auth-token/) }),
      );
    } finally {
      await context.close();
    }
  });

  test("the landing throws after Auth verified: the answer is the linkTimeout landing, not a 500", async ({ browser, baseURL }) => {
    // Kills: a route with no try around the landing.
    const email = newAddress();
    await listAddress(email);
    const { context, page } = await fresh(browser, baseURL!);
    let constraint = "";
    try {
      await requestLink(page, email);
      const confirm = await confirmPath(email);
      const userId = await userIdOf(email);
      // Refuses this one user's `app_users` row and nobody else's: the landing's insert throws.
      constraint = `m40_refuse_${stamp}_${serial}`;
      await fixtureSql.unsafe(
        `alter table finances.app_users add constraint ${constraint} check (id <> '${userId}'::uuid) not valid`,
      );

      const answer = await page.request.get(confirm, { maxRedirects: 0 });
      expect(answer.status(), "a bare 500 is the failure").toBeGreaterThanOrEqual(300);
      expect(answer.status()).toBeLessThan(400);
      const location = new URL(answer.headers().location!);
      expect(location.pathname + location.search).toBe("/es/login?error=linkTimeout");

      await page.goto("/es/login?error=linkTimeout");
      await expect(page.locator("main").getByRole("alert")).toHaveText(LINK_TIMEOUT_LINE);
    } finally {
      if (constraint) await fixtureSql.unsafe(`alter table finances.app_users drop constraint if exists ${constraint}`);
      await context.close();
    }
  });

  test("a good link still lands on the home page, signed in, with no notice", async ({ browser, baseURL }) => {
    // Kills: a try that sends a landing that works to the login.
    const email = newAddress();
    await listAddress(email);
    const { context, page } = await fresh(browser, baseURL!);
    try {
      await requestLink(page, email);
      await page.goto(await confirmPath(email));
      await expect(page).toHaveURL(/\/es$/);
      await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
      expect(await context.cookies()).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/auth-token/) }));
    } finally {
      await context.close();
    }
  });
});

test.describe("sign-out", () => {
  // Signs a new person in through the mailed link, so ending the session never touches the harness user's.
  async function signedIn(browser: Browser, baseURL: string) {
    const email = newAddress();
    await listAddress(email);
    const opened = await fresh(browser, baseURL);
    await requestLink(opened.page, email);
    await opened.page.goto(await confirmPath(email));
    await expect(opened.page).toHaveURL(/\/es$/);
    await opened.page.goto("/es/settings");
    return opened;
  }

  test("a sign-out the action refused shows signOutFailed and leaves the person on the page", async ({ browser, baseURL }) => {
    // Kills: a sign-out button with no onError, whose refusal is silent.
    const { context, page } = await signedIn(browser, baseURL!);
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      await page.route("**/es/settings", async (route) => {
        if (!route.request().headers()["next-action"]) return route.continue();
        calls += 1;
        await held;
        await route.fulfill({
          status: 200,
          contentType: "text/x-component",
          body: '0:{"a":"$@1","f":"","b":"x"}\n1:{"serverError":"errors.signOutFailed"}\n',
        });
      });

      const button = page.getByRole("button", { name: auth.signOut, exact: true });
      await button.click();
      // While the action runs the button refuses a second press.
      await expect(button).toBeDisabled();
      release();

      await expect(page.getByText(messages.errors.signOutFailed)).toBeVisible();
      await expect(button).toBeEnabled();
      await expect(page).toHaveURL(/\/es\/settings$/);
      expect(calls).toBe(1);
      expect(await context.cookies()).toContainEqual(expect.objectContaining({ name: expect.stringMatching(/auth-token/) }));
    } finally {
      await context.close();
    }
  });

  test("an ordinary sign-out lands on the login", async ({ browser, baseURL }) => {
    // Kills: an onError that toasts a sign-out that worked.
    const { context, page } = await signedIn(browser, baseURL!);
    try {
      await page.getByRole("button", { name: auth.signOut, exact: true }).click();
      await expect(page).toHaveURL(/\/es\/login/);
      await expect(page.getByText(messages.errors.signOutFailed)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
