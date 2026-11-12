/**
 * RF-06 and RF-07 on the onboarding invite step, driven the way a person reaches it.
 *
 * The step owes four things. A blank or malformed address is refused on the form,
 * before any request leaves. A request that skips the form (a forged one) is
 * refused by the server on the same rule and writes nothing. A valid address
 * becomes a member named by it (cut at the name's cap of 80, whatever the address
 * length) and one message in the local mailbox. And the server, never the client,
 * names the member.
 *
 * Every send goes to the local stack's inbox (mailpit, :44324) under
 * `scripts/supabase-local.sh exec`; the addresses are `harness-inv-<uuid>@...invalid`
 * and never reach a real mailbox. The `auth.users` row a send mints is registered
 * under the run at once and dropped by exact address at the end.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { expect, type Locator, type Page, } from "@playwright/test";

import { addressKey, callerKey } from "@/lib/auth/client-key";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  LEADER_MEMBER_NAME,
  asHarnessUser,
  clearGroup,
  readScope,
  test,
} from "./global-setup";

const step = messages.onboarding.inviteStep;
const members = messages.members;
const MAILBOX = "http://127.0.0.1:44324";

let groupId = "";

function invitee(): string {
  return `harness-inv-${randomUUID()}@example.invalid`;
}

// The caller leads a group of one: nobody else is on the roster.
async function seedLeaderOnlyGroup(): Promise<string> {
  const { userId } = readScope();
  const id = randomUUID();

  await clearGroup();
  await asHarnessUser(async (tx) => {
    await tx`insert into groups (id, name, cash_mode) values (${id}, 'Fondo de la invitación', 'per_member')`;
    await tx`
      insert into group_members (group_id, user_id, name, role)
      values (${id}, ${userId}, ${LEADER_MEMBER_NAME}, 'leader')`;
  });

  return id;
}

async function rosterRows(): Promise<{ name: string; invite_email: string | null }[]> {
  return fixtureSql<{ name: string; invite_email: string | null }[]>`
    select name, invite_email from group_members where group_id = ${groupId} order by name`;
}

async function inviteRows(email: string) {
  return fixtureSql<{ name: string }[]>`
    select name from group_members where group_id = ${groupId} and lower(invite_email) = ${email.toLowerCase()}`;
}

// The send mints an `auth.users` row (shouldCreateUser). Registering it under the
// run lets a crash leave it to the teardown; dropping it by exact address ends it.
// The action writes the member, then asks Auth to send: the `auth.users` row lands
// a moment after the member does. Waiting for it is what keeps `forget` from running
// ahead of the send and leaving the row behind.
async function minted(email: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [{ n }] = await fixtureSql<{ n: number }[]>`select count(*)::int as n from auth.users where email = ${email}`;
    if (n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function register(email: string) {
  await minted(email, 10_000);
  const runId = process.env.HARNESS_RUN_ID;
  if (!runId) return;
  await fixtureSql`
    insert into harness.identities (user_id, run_id, email, disposition)
    select id, ${runId}, email, 'ephemeral' from auth.users where email = ${email}
    on conflict do nothing`;
}

async function forget(email: string) {
  // A send is under way only when the invite landed as a member.
  if ((await inviteRows(email)).length > 0) await minted(email, 10_000);
  const ids = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  for (const { id } of ids) {
    await fixtureSql`delete from harness.identities where user_id = ${id}`;
    await fixtureSql`delete from auth.users where id = ${id}`;
  }
}

async function mailCount(email: string): Promise<number> {
  const found = await (
    await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json();
  return found.messages_count ?? 0;
}

function countActionPosts(page: Page): { count: () => number; bodies: string[] } {
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && "next-action" in request.headers()) {
      bodies.push(request.postData() ?? "");
    }
  });
  return { count: () => bodies.length, bodies };
}

async function openStep(page: Page) {
  await page.goto("/es/onboarding/invite");
  const input = page.getByPlaceholder(step.emailPlaceholder);
  await expect(input).toBeVisible();
  return {
    input,
    send: page.getByRole("button", { name: step.sendInvite, exact: true }),
  };
}

function cards(page: Page): Locator {
  return page.locator("main .rt-Card");
}

test.beforeEach(async () => {
  groupId = await seedLeaderOnlyGroup();
});

test.afterAll(async () => {
  await clearGroup();
});

test("a valid address creates a member named by it, one card, one message; the form sends the address alone", async ({
  page,
}) => {
  // Kills: the form sending `name: ""` (or any name) with the address; the member would not be named by it.
  const email = invitee();
  const posts = countActionPosts(page);
  const { input, send } = await openStep(page);
  try {
    await input.fill(email);
    await send.click();

    await expect(cards(page).filter({ hasText: email })).toHaveCount(1);
    await register(email);

    const rows = await inviteRows(email);
    expect(rows).toEqual([{ name: email }]);
    expect(await rosterRows()).toHaveLength(2);
    await expect.poll(() => mailCount(email)).toBe(1);

    // The invite is the address and nothing else: the name is the server's to derive.
    expect(posts.count()).toBe(1);
    const sent = JSON.parse(posts.bodies[0]) as Record<string, unknown>[];
    expect(Object.keys(sent[0])).toEqual(["email"]);
    expect(sent[0].email).toBe(email);
  } finally {
    await forget(email);
  }
});

/**
 * RF-07, RF-149: from onboarding, «Agregar sin correo» opens the members dialog with the name alone.
 */
test.describe("«Agregar sin correo» asks for a name alone", () => {
  async function openDialog(page: Page) {
    await openStep(page);
    await page.getByRole("button", { name: step.addWithoutEmail, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: members.nameLabel })).toBeVisible();
    return dialog;
  }

  test("saving adds a member with no address, no mail and a POST without an email key", async ({ page }) => {
    // Kills: sending `email: ""` as an address; spreading the defaults into the payload.
    const name = `Sin correo ${randomUUID().slice(0, 8)}`;
    const posts = countActionPosts(page);
    const dialog = await openDialog(page);

    await dialog.getByRole("textbox", { name: members.nameLabel }).fill(name);
    await dialog.getByRole("button", { name: messages.common.save, exact: true }).click();

    await expect(page.getByText(members.created, { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    const card = cards(page).filter({ hasText: name });
    await expect(card).toHaveCount(1);
    await expect(card.getByText(members.pendingBadge, { exact: true })).toHaveCount(0);

    expect(posts.count()).toBe(1);
    const sent = JSON.parse(posts.bodies[0]) as Record<string, unknown>[];
    expect(Object.keys(sent[0])).toEqual(["name"]);
    const rows = await rosterRows();
    expect(rows.find((row) => row.name === name)?.invite_email).toBeNull();
    expect(await mailCount(name)).toBe(0);
  });
});

/**
 * RF-148: the invitation is Auth's own template, asked of Auth from the server with the project's
 * secret key; the inviter's browser never requests a sign-in code. Written from the contract:
 * the subject «Te invitaron a HomeFund», one link and no code in the mail; no PKCE verifier in the
 * leader's cookies; the invitee listed (RF-145, by the 0058 trigger); the invitee signs in with a
 * code and lands on /es/bienvenida as the member; an address Auth already holds gets no mail and
 * the leader a notice; no key reaches a client chunk.
 *
 * These rows need the stack to run the `invite.html` (subject, no code) and a server holding
 * `SUPABASE_SECRET_KEY` (its `print_env`); until both are there they go red for that reason too.
 * The «no key» row lives in `lib/auth/invite-email.test.ts`: a dev server cannot drop its key per test.
 */
const INVITE_SUBJECT = "Te invitaron a HomeFund";
const SIX_DIGITS = /(?<!\d)\d{6}(?!\d)/;

type MailSummary = { ID: string; Subject: string };

async function mailsTo(email: string): Promise<MailSummary[]> {
  const found = (await (
    await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages?: MailSummary[] };
  return found.messages ?? [];
}

async function mailBody(id: string): Promise<{ Subject: string; Text: string; HTML: string }> {
  return (await (await fetch(`${MAILBOX}/api/v1/message/${id}`)).json()) as {
    Subject: string;
    Text: string;
    HTML: string;
  };
}

async function dropListing(email: string) {
  await fixtureSql`delete from finances.allowed_emails where email = ${email.toLowerCase()}`;
}

// Invites through the step the way the leader does and waits until the whole send is over.
async function inviteThroughStep(page: Page, email: string) {
  const { input, send } = await openStep(page);
  await input.fill(email);
  await send.click();
  await expect(cards(page).filter({ hasText: email })).toHaveCount(1);
}

test.describe("the invitation is Auth's own mail, sent from the server (RF-148)", () => {
  test("the invitee gets one mail, «Te invitaron a HomeFund», with no six-digit code", async ({ page }) => {
    // Kills: restoring `signInWithOtp` (the mail is the code mail: another subject, a code in it).
    const email = invitee();
    try {
      await inviteThroughStep(page, email);
      await register(email);
      await expect.poll(() => mailCount(email)).toBe(1);

      const [mail] = await mailsTo(email);
      const body = await mailBody(mail.ID);
      expect(body.Subject).toBe(INVITE_SUBJECT);
      expect(body.Text).not.toMatch(SIX_DIGITS);
      expect(body.HTML).not.toMatch(SIX_DIGITS);
    } finally {
      await dropListing(email);
      await forget(email);
    }
  });

  test("the invitee types the address, gets a code, signs in and is still only invited", async ({
    page,
    browser,
    baseURL,
  }) => {
    // Kills: claiming the invitation on sign-in (RF-154: the member stays pending until the person accepts),
    // and an invitation that leaves the invitee unable to sign in by code.
    const email = invitee();
    const salt = process.env.CLIENT_KEY_SALT ?? "";
    const ip = `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
    const callerClaim = callerKey(new Headers({ "x-forwarded-for": ip }), salt);
    const addressClaim = addressKey(email, salt);
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { "x-forwarded-for": ip },
    });
    try {
      await inviteThroughStep(page, email);
      await register(email);
      await expect.poll(() => mailCount(email)).toBe(1);
      const [{ id: memberId }] = await fixtureSql<{ id: string }[]>`
        select id from group_members where group_id = ${groupId} and lower(invite_email) = ${email}`;

      const visitor = await context.newPage();
      await visitor.goto("/es/login");
      await visitor.getByLabel(messages.auth.emailLabel).fill(email);
      await visitor.getByRole("button", { name: "Enviar código", exact: true }).click();
      await expect(visitor.getByRole("heading", { name: "Revisa tu correo", exact: true })).toBeVisible();

      // The newest mail is the sign-in code; the invitation before it carries none.
      let code = "";
      await expect
        .poll(async () => {
          const all = await mailsTo(email);
          if (all.length < 2) return "";
          const text = (await mailBody(all[0].ID)).Text;
          code = text.match(/^\d{6}$/m)?.[0] ?? "";
          return code;
        })
        .toMatch(/^\d{6}$/);

      await visitor.getByLabel("Código del correo", { exact: true }).fill(code);
      await visitor.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(visitor).toHaveURL(/\/es$/);

      const [member] = await fixtureSql<{ user_id: string | null; invite_state: string; invite_email: string | null }[]>`
        select user_id, invite_state, invite_email from group_members where id = ${memberId}`;
      const [user] = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
      expect(member).toEqual({ user_id: null, invite_state: "pending", invite_email: email });
      const memberships = await fixtureSql<{ id: string }[]>`select id from group_members where user_id = ${user.id}`;
      expect(memberships).toEqual([]);
    } finally {
      await context.close();
      const [user] = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
      if (user) {
        await fixtureSql`update group_members set user_id = null where user_id = ${user.id}`;
      }
      await fixtureSql`delete from finances.sign_in_claims where client_key in ${fixtureSql([callerClaim, addressClaim].filter((key): key is string => Boolean(key)))}`;
      await dropListing(email);
      await forget(email);
    }
  });
});
