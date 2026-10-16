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
 * Every send goes to the local stack's inbox (mailpit, :54324) under
 * `scripts/supabase-local.sh exec`; the addresses are `harness-inv-<uuid>@...invalid`
 * and never reach a real mailbox. The `auth.users` row a send mints is registered
 * under the run at once and dropped by exact address at the end.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, type Route } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  LEADER_MEMBER_NAME,
  MEMBER_STORAGE_STATE,
  STORAGE_STATE,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const step = messages.onboarding.inviteStep;
const members = messages.members;
const MAILBOX = "http://127.0.0.1:54324";
const NAME_MAX = 80;

let groupId = "";

function invitee(): string {
  return `harness-inv-${randomUUID()}@example.invalid`;
}

// A valid address (local part within 64) of more than 80 characters in all.
function longInvitee(): string {
  return `harness-inv-${randomUUID()}-${"x".repeat(15)}@mail.example.invalid`;
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

// A server action is a POST carrying `Next-Action`.
function isAction(route: Route): boolean {
  const request = route.request();
  return request.method() === "POST" && "next-action" in request.headers();
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

test("a blank address is refused on the form and no request leaves", async ({ page }) => {
  // Kills: the form resolver off (a blank submit reaches the server).
  const posts = countActionPosts(page);
  const { send } = await openStep(page);

  await send.click();

  await expect(page.getByText(members.errors.emailInvalid, { exact: true })).toBeVisible();
  expect(posts.count()).toBe(0);
  expect(await rosterRows()).toHaveLength(1);
});

test("a malformed address is refused on the form with the same words and no request", async ({
  page,
}) => {
  // Kills: the form's schema dropping its `.pipe(z.email())` (a malformed address goes out).
  const posts = countActionPosts(page);
  const { input, send } = await openStep(page);

  await input.fill("ana@");
  await send.click();

  await expect(page.getByText(members.errors.emailInvalid, { exact: true })).toBeVisible();
  expect(posts.count()).toBe(0);
  expect(await rosterRows()).toHaveLength(1);
});

test("a forged request with an address that is not one is refused by the server and writes nothing", async ({
  page,
}) => {
  // Kills: the action validating on a laxer schema than the form's (the address "x" lands as a member).
  const email = invitee();
  const answers: string[] = [];
  await page.route("**/onboarding/invite*", async (route) => {
    if (!isAction(route)) return route.fallback();
    // The form let a valid address through; the wire carries what the form never would.
    const forged = (route.request().postData() ?? "").replaceAll(email, "x");
    const response = await route.fetch({ postData: forged });
    answers.push(await response.text());
    await route.fulfill({ response });
  });

  const { input, send } = await openStep(page);
  try {
    await input.fill(email);
    await send.click();
    await expect.poll(() => answers.length).toBe(1);

    expect(answers[0]).not.toContain("memberId");
    expect(await rosterRows()).toHaveLength(1);
    expect(await mailCount(email)).toBe(0);
  } finally {
    await forget(email);
  }
});

test("a forged request that names the member is ignored: the server names it by the address", async ({
  page,
}) => {
  // Kills: the action taking the member's name from the request instead of from the address.
  const email = invitee();
  await page.route("**/onboarding/invite*", async (route) => {
    if (!isAction(route)) return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "[]") as Record<string, unknown>[];
    body[0] = { ...body[0], name: "Impostor" };
    await route.continue({ postData: JSON.stringify(body) });
  });

  const { input, send } = await openStep(page);
  try {
    await input.fill(email);
    await send.click();
    await expect.poll(async () => (await inviteRows(email)).length).toBe(1);
    await register(email);

    expect((await inviteRows(email))[0].name).toBe(email);
    expect((await rosterRows()).some((row) => row.name === "Impostor")).toBe(false);
  } finally {
    await forget(email);
  }
});

test("while the send is held the button is disabled and shows a spinner; then the member lands", async ({
  page,
}) => {
  // Kills: the button left enabled while the action runs (a second tap sends a second invite).
  const email = invitee();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/onboarding/invite*", async (route) => {
    if (!isAction(route)) return route.fallback();
    await gate;
    await route.continue();
  });

  const { input, send } = await openStep(page);
  try {
    await input.fill(email);
    await send.click();

    await expect(send).toBeDisabled();
    await expect(send.locator(".rt-Spinner")).toBeVisible();
    expect(await inviteRows(email)).toHaveLength(0);

    release();
    await expect.poll(async () => (await inviteRows(email)).length).toBe(1);
    await register(email);
    await expect(send).toBeEnabled();
  } finally {
    release();
    await forget(email);
  }
});

test("«Ir al panel» leaves the step with no member written", async ({ page }) => {
  // Kills: the way out writing a member (a stray draft row) or not leaving.
  const { input } = await openStep(page);
  await input.fill("a-person@example.invalid");

  await page.getByRole("link", { name: step.toDashboard, exact: true }).click();

  await expect(page).toHaveURL(/\/es\/?$/);
  expect(await rosterRows()).toHaveLength(1);
});

test("a group of one shows only the caller's own card, and the way out is there", async ({ page }) => {
  // Kills: the roster rendering an extra, empty card when nobody else is on it.
  await openStep(page);

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText(LEADER_MEMBER_NAME);
  await expect(page.getByRole("link", { name: step.toDashboard, exact: true })).toBeVisible();
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

test("an address over 80 characters still invites: the member's name is its first 80", async ({ page }) => {
  // Kills: sending the whole address as the name (the server refuses it as «nameTooLong»).
  const email = longInvitee();
  expect(email.length).toBeGreaterThan(NAME_MAX);
  const { input, send } = await openStep(page);
  try {
    await input.fill(email);
    await send.click();

    await expect.poll(async () => (await inviteRows(email)).length).toBe(1);
    await register(email);

    expect((await inviteRows(email))[0].name).toBe(email.slice(0, NAME_MAX));
    await expect(page.getByText(members.errors.nameTooLong, { exact: true })).toHaveCount(0);
    await expect.poll(() => mailCount(email)).toBe(1);
  } finally {
    await forget(email);
  }
});

test("a roster disc is 36 by 36 and round", async ({ page }) => {
  // Kills: the disc's size prop ignored (it falls back to its own default).
  await openStep(page);

  const disc = cards(page).first().getByText(LEADER_MEMBER_NAME.charAt(0), { exact: true });
  await expect(disc).toBeVisible();
  const box = await disc.boundingBox();
  expect(box?.width).toBe(36);
  expect(box?.height).toBe(36);
  const radius = await disc.evaluate((node) => parseFloat(getComputedStyle(node).borderRadius));
  expect(radius).toBeGreaterThanOrEqual(18);
});

test.describe("a refusal reads as the one that happened", () => {
  test.describe("a plain member", () => {
    test.use({ storageState: MEMBER_STORAGE_STATE });

    test("inviting by address reads «only the owner», writes no member and sends no mail", async ({ page }) => {
      // Kills: the `notLeader()` mapping dropped from the invite action, or its 42501 test inverted (the member reads the generic error).
      groupId = (await seedGroup()).groupId;
      const email = invitee();
      const { input, send } = await openStep(page);
      try {
        await input.fill(email);
        await send.click();

        await expect(page.getByText(messages.errors.notLeader, { exact: true })).toBeVisible();
        await expect(page.getByText(messages.errors.unexpected, { exact: true })).toHaveCount(0);
        expect(await inviteRows(email)).toHaveLength(0);
        expect(await mailCount(email)).toBe(0);
      } finally {
        await forget(email);
      }
    });

    test("a forged add-member call reads «only the owner» and writes no member", async ({ page, browser }) => {
      // Kills: the `notLeader()` mapping dropped from the add-member action, or its 42501 test inverted.
      groupId = (await seedGroup()).groupId;
      const seen: { id: string; body: string; url: string }[] = [];

      // The leader's own add-member call, caught on the wire to learn the action's id and body shape.
      const leader = await browser.newContext({ storageState: STORAGE_STATE });
      try {
        const leaderPage = await leader.newPage();
        leaderPage.on("request", (request) => {
          const id = request.headers()["next-action"];
          if (request.method() === "POST" && id) {
            seen.push({ id, body: request.postData() ?? "", url: request.url() });
          }
        });
        await leaderPage.goto("/es/settings/members");
        await leaderPage.getByRole("button", { name: members.add, exact: true }).filter({ visible: true }).first().click();
        const dialog = leaderPage.getByRole("dialog");
        await dialog.getByRole("textbox", { name: members.nameLabel }).fill(`Harness reenviado ${randomUUID().slice(0, 8)}`);
        await dialog.getByRole("button", { name: messages.common.save, exact: true }).click();
        await expect.poll(() => seen.length).toBeGreaterThan(0);
        await expect(dialog).toBeHidden();
      } finally {
        await leader.close();
      }

      const before = (await rosterRows()).length;
      const forged = { ...seen[0], body: JSON.stringify([{ name: "Intruso de la prueba" }]) };
      const answer = await page.request.post(forged.url, {
        headers: {
          "next-action": forged.id,
          "content-type": "text/plain;charset=UTF-8",
          accept: "text/x-component",
        },
        data: forged.body,
      });

      expect(await answer.text()).toContain("errors.notLeader");
      expect((await rosterRows()).length).toBe(before);
    });
  });

  test("a leader's second invitation to a pending address reads as a failure, never «only the owner»", async ({ page }) => {
    // Kills: the 42501 test inverted in the invite action (every refusal other than the owner's reads «only the owner»).
    const email = invitee();
    const { input, send } = await openStep(page);
    try {
      await input.fill(email);
      await send.click();
      await expect(cards(page).filter({ hasText: email })).toHaveCount(1);
      await register(email);

      await input.fill(email);
      await send.click();

      await expect(page.getByText(messages.errors.unexpected, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.errors.notLeader, { exact: true })).toHaveCount(0);
      expect(await inviteRows(email)).toHaveLength(1);
    } finally {
      await forget(email);
    }
  });
});
