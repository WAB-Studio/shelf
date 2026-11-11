/**
 * RF-153 on «Editar miembro»: a member with no login and no pending invitation can be given an
 * address, and saving it invites her (RF-149); a member who already has a login or an invitation
 * is edited by name alone. The three refusals the create dialog puts on the address field
 * (RF-150, RF-152) land on the same field here. Both Playwright projects run every test, so the
 * phone's card menu (360) and the laptop's row menu (1280) are each driven.
 *
 * Every address is `harness-m4-<uuid>@example.invalid`, except the one `example.com` row, whose
 * domain must answer DNS as taking no mail. The helpers are copied from `members.spec.ts`.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  asHarnessUser,
  clearGroup,
  seedGroup,
  test,
} from "./global-setup";

const members = messages.members;
const common = messages.common;
const stamp = randomUUID().slice(0, 8);
const MAILBOX = "http://127.0.0.1:44324";

let groupId = "";

test.beforeEach(async () => {
  ({ groupId } = await seedGroup());
});

test.afterAll(async () => {
  await clearGroup();
});

function freshAddress(): string {
  return `harness-m4-${randomUUID()}@example.invalid`;
}

function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

// The band the width displays: the laptop's table and the phone's cards are both in the DOM.
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

async function nameRow(page: Page, name: string): Promise<Locator> {
  await band(page).getByText(name).first().waitFor();

  const row = page
    .getByRole("table", { name: members.title })
    .getByRole("row")
    .filter({ hasText: name });
  if ((await row.count()) > 0) return row;

  return band(page).locator("div").filter({ hasText: name }).last();
}

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

async function forget(email: string, { sent = true }: { sent?: boolean } = {}) {
  if (sent) await minted(email, 10_000);
  const ids = await fixtureSql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  for (const { id } of ids) {
    await fixtureSql`delete from harness.identities where user_id = ${id}`;
    await fixtureSql`delete from auth.users where id = ${id}`;
  }
  await fixtureSql`delete from finances.allowed_emails where email = ${email.toLowerCase()}`;
}

async function mailCount(email: string): Promise<number> {
  const found = await (
    await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json();
  return found.messages_count ?? 0;
}

async function listed(email: string): Promise<number> {
  const [{ n }] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from finances.allowed_emails where email = ${email.toLowerCase()}`;
  return n;
}

function actionPosts(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && "next-action" in request.headers()) {
      bodies.push(request.postData() ?? "");
    }
  });
  return bodies;
}

// A member the leader added by name alone: no login, no address, no invitation.
async function seedPlaceholder(): Promise<{ id: string; name: string }> {
  const name = `Abuela ${stamp}`;
  await asHarnessUser(async (tx) => {
    await tx`insert into group_members (group_id, name, role) values (${groupId}, ${name}, 'member')`;
  });
  const [row] = await fixtureSql<{ id: string }[]>`
    select id from group_members where group_id = ${groupId} and name = ${name}`;
  return { id: row.id, name };
}

async function stored(id: string) {
  const [row] = await fixtureSql<{ name: string; invite_email: string | null; user_id: string | null }[]>`
    select name, invite_email, user_id from group_members where id = ${id}`;
  return row;
}

async function openEdit(page: Page, name: string): Promise<Locator> {
  await page.goto("/es/settings/members");
  await rowMenu(page, name).click();
  await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: members.editTitle })).toBeVisible();
  return dialog;
}

const nameField = (dialog: Locator) => dialog.getByLabel(members.nameLabel, { exact: true });
const emailField = (dialog: Locator) => dialog.getByLabel(members.emailLabel, { exact: true });
const saveButton = (dialog: Locator) => dialog.getByRole("button", { name: common.save, exact: true });
const toastsOf = (page: Page) => page.locator("[data-sonner-toast]");

async function expectPendingRow(page: Page, name: string, email: string) {
  const row = await nameRow(page, name);
  await expect(row).toContainText(members.pendingBadge);
  // Only the phone's card keeps «Sin acceso» beside the pending badge; the laptop's table swaps one for the other.
  if ((page.viewportSize()?.width ?? 0) < 1024) await expect(row).toContainText(members.noLoginBadge);
  await expect(band(page).getByText(email, { exact: true })).toBeVisible();
  await expect(
    band(page).locator("div, tr").filter({ hasText: name }).filter({ hasText: email }).first(),
  ).toBeVisible();
}

test.describe("RF-153: «Editar miembro» on a member with no login and no invitation", () => {

  test("a fresh address invites: toast, the dialog closes, the row turns pending with the address, one mail, listed", async ({
    page,
  }) => {
    // Kills: dropping `email` from the edit POST; toasting the warning on any `data`; not listing the address.
    const { id, name } = await seedPlaceholder();
    const address = freshAddress();
    const dialog = await openEdit(page, name);
    try {
      await emailField(dialog).fill(address);
      await saveButton(dialog).click();

      await expect(page.getByText(members.updated, { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expectPendingRow(page, name, address);
      await expect(toastsOf(page).filter({ hasText: members.editEmailFailed })).toHaveCount(0);

      await register(address);
      await expect.poll(() => mailCount(address)).toBe(1);
      expect(await stored(id)).toEqual({ name, invite_email: address, user_id: null });
      expect(await listed(address)).toBe(1);
    } finally {
      await forget(address);
    }
  });

  test("a rename with the address left blank renames only: POST without an address, «Sin acceso» kept, nothing mailed", async ({
    page,
  }) => {
    // Kills: sending `email: ""` on every edit.
    const { id, name } = await seedPlaceholder();
    const posts = actionPosts(page);
    const dialog = await openEdit(page, name);
    const renamed = `Renombrada ${stamp}`;

    await nameField(dialog).fill(renamed);
    await saveButton(dialog).click();

    await expect(page.getByText(members.updated, { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(posts).toHaveLength(1);
    // An absent address crosses the wire as `$undefined`; `""` or a value would be a send.
    expect(posts[0]).not.toMatch(/"email":(?!"\$undefined")/);
    const row = await nameRow(page, renamed);
    await expect(row).toContainText(members.noLoginBadge);
    await expect(row).not.toContainText(members.pendingBadge);
    expect(await stored(id)).toEqual({ name: renamed, invite_email: null, user_id: null });
    await expect(toastsOf(page).filter({ hasText: members.editEmailFailed })).toHaveCount(0);
  });
});
