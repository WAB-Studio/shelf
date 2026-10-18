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
  LEADER_MEMBER_NAME,
  PLAIN_MEMBER_NAME,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const members = messages.members;
const common = messages.common;
const errors = messages.errors;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const MAILBOX = "http://127.0.0.1:54324";

const alreadyMember = members.errors.alreadyMember;
const emailTaken = members.errors.emailTaken;
const undeliverable = errors.domainUndeliverable;
const createWarning = messages.onboarding.inviteStep.emailFailed;

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

async function addressOf(userId: string): Promise<string> {
  const [row] = await fixtureSql<{ email: string }[]>`select email from auth.users where id = ${userId}`;
  expect(row?.email, "the harness identity has an address").toBeTruthy();
  return row.email;
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

async function seedPending(name: string, email: string) {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into group_members (group_id, name, role, invite_email)
      values (${groupId}, ${name}, 'member', ${email})`;
  });
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

async function rosterCount(): Promise<number> {
  const [{ n }] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from group_members where group_id = ${groupId}`;
  return n;
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
const cancelButton = (dialog: Locator) => dialog.getByRole("button", { name: common.cancel, exact: true });
const toastsOf = (page: Page) => page.locator("[data-sonner-toast]");

// The field's own group: holds `#member-email` and not `#member-name`.
const emailGroup = (dialog: Locator) =>
  dialog
    .getByRole("group")
    .filter({ has: dialog.page().locator("#member-email") })
    .filter({ hasNot: dialog.page().locator("#member-name") });

async function recordToasts(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __toastsSeen: seen });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const toasts = node.matches("[data-sonner-toast]")
            ? [node]
            : [...node.querySelectorAll("[data-sonner-toast]")];
          for (const toast of toasts) seen.push(toast.textContent ?? "");
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}
const toastsSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toastsSeen: string[] }).__toastsSeen);
const twoFrames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );

async function expectPendingRow(page: Page, name: string, email: string) {
  const row = await nameRow(page, name);
  await expect(row).toContainText(members.pendingBadge);
  await expect(row).toContainText(members.noLoginBadge);
  await expect(band(page).getByText(email, { exact: true })).toBeVisible();
  await expect(
    band(page).locator("div, tr").filter({ hasText: name }).filter({ hasText: email }).first(),
  ).toBeVisible();
}

async function expectFieldRefusal(dialog: Locator, words: string, address: string, name: string) {
  await expect(emailGroup(dialog).getByText(words, { exact: true })).toBeVisible();
  await expect(dialog.locator("#member-email")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator("#member-name")).not.toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toHaveAttribute("data-state", "open");
  await expect(nameField(dialog)).toHaveValue(name);
  await expect(emailField(dialog)).toHaveValue(address);
}

test.describe("RF-153: «Editar miembro» on a member with no login and no invitation", () => {
  test("opens on «Nombre» holding her name, with «Correo (opcional)» empty and its hint", async ({ page }) => {
    // Kills: drawing the field on `!isEdit` alone (today); an `invitable` that is always false.
    const { name } = await seedPlaceholder();
    const dialog = await openEdit(page, name);

    await expect(nameField(dialog)).toHaveValue(name);
    const email = emailField(dialog);
    await expect(email).toBeVisible();
    await expect(email).toHaveValue("");
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("id", "member-email");
    await expect(dialog.getByText(members.emailHint, { exact: true })).toBeVisible();
  });

  test("a pending member's «Editar miembro» has «Nombre» only: no address field, no hint", async ({ page }) => {
    // Kills: `invitable` computed from `userId` alone.
    const address = freshAddress();
    const name = `Pendiente ${stamp}`;
    await seedPending(name, address);
    try {
      const dialog = await openEdit(page, name);

      await expect(nameField(dialog)).toHaveValue(name);
      await expect(dialog.getByLabel(members.emailLabel)).toHaveCount(0);
      await expect(dialog.getByText(members.emailHint, { exact: true })).toHaveCount(0);
    } finally {
      await forget(address, { sent: false });
    }
  });

  for (const [who, name] of [
    ["the plain member with a login", PLAIN_MEMBER_NAME],
    ["the leader's own row", LEADER_MEMBER_NAME],
  ] as const) {
    test(`${who}: «Editar miembro» has «Nombre» only`, async ({ page }) => {
      // Kills: `invitable` computed from `inviteEmail` alone (a login has no invitation, so the field would draw).
      const dialog = await openEdit(page, name);

      await expect(nameField(dialog)).toHaveValue(name);
      await expect(dialog.getByLabel(members.emailLabel)).toHaveCount(0);
      await expect(dialog.getByText(members.emailHint, { exact: true })).toHaveCount(0);
    });
  }

  test("a malformed address is refused on the field by the shared schema and no request leaves", async ({ page }) => {
    // Kills: the edit not validated with the address (the malformed one goes to the server).
    const { id, name } = await seedPlaceholder();
    const posts = actionPosts(page);
    const dialog = await openEdit(page, name);

    await emailField(dialog).fill("abuela@");
    await saveButton(dialog).click();

    await expect(emailGroup(dialog).getByText(members.errors.emailInvalid, { exact: true })).toBeVisible();
    await expect(dialog).toHaveAttribute("data-state", "open");
    expect(posts).toHaveLength(0);
    expect((await stored(id)).invite_email).toBeNull();
  });

  test("while saving, both fields and both buttons are disabled and «Guardar» spins", async ({ page }) => {
    // Kills: leaving the address field enabled while the update is pending.
    const { name } = await seedPlaceholder();
    const address = freshAddress();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/settings/members", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
      await gate;
      return route.fallback();
    });
    const dialog = await openEdit(page, name);
    try {
      await emailField(dialog).fill(address);
      await saveButton(dialog).click();

      await expect(nameField(dialog)).toBeDisabled();
      await expect(emailField(dialog)).toBeDisabled();
      await expect(cancelButton(dialog)).toBeDisabled();
      await expect(saveButton(dialog)).toBeDisabled();
      await expect(saveButton(dialog).locator(".rt-Spinner")).toBeVisible();
    } finally {
      release();
      await expect(dialog).toHaveCount(0);
      await register(address);
      await forget(address);
    }
  });

  test("«Cancelar» after typing an address closes the dialog, sends nothing and leaves the row", async ({ page }) => {
    // Kills: submitting on close.
    const { id, name } = await seedPlaceholder();
    const address = freshAddress();
    const posts = actionPosts(page);
    const dialog = await openEdit(page, name);

    await nameField(dialog).fill(`Otra ${stamp}`);
    await emailField(dialog).fill(address);
    await cancelButton(dialog).click();

    await expect(dialog).toHaveCount(0);
    await twoFrames(page);
    expect(posts).toHaveLength(0);
    expect(await stored(id)).toEqual({ name, invite_email: null, user_id: null });
    const row = await nameRow(page, name);
    await expect(row).toContainText(members.noLoginBadge);
    await expect(row).not.toContainText(members.pendingBadge);
    expect(await mailCount(address)).toBe(0);
  });

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
    expect(posts[0]).not.toContain("email");
    const row = await nameRow(page, renamed);
    await expect(row).toContainText(members.noLoginBadge);
    await expect(row).not.toContainText(members.pendingBadge);
    expect(await stored(id)).toEqual({ name: renamed, invite_email: null, user_id: null });
    await expect(toastsOf(page).filter({ hasText: members.editEmailFailed })).toHaveCount(0);
  });

  test("an address Auth already holds leaves the row pending and raises exactly one «editEmailFailed» warning", async ({
    page,
  }) => {
    // Kills: showing the create dialog's `emailFailed` words; raising the warning twice or never.
    const { id, name } = await seedPlaceholder();
    const address = freshAddress();
    await fixtureSql`
      insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
              'authenticated', ${address}, now(), now())`;
    await register(address);
    const dialog = await openEdit(page, name);
    try {
      await emailField(dialog).fill(address);
      await saveButton(dialog).click();

      await expect(page.getByText(members.updated, { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(toastsOf(page).filter({ hasText: members.editEmailFailed })).toHaveCount(1);
      await expect(toastsOf(page).filter({ hasText: createWarning })).toHaveCount(0);
      await expectPendingRow(page, name, address);
      expect((await stored(id)).invite_email).toBe(address);
      expect(await mailCount(address)).toBe(0);
    } finally {
      await forget(address);
    }
  });
});

test.describe("RF-150, RF-152: the refusals land on the address field of «Editar miembro»", () => {
  async function submitAddress(page: Page, address: string) {
    const placeholder = await seedPlaceholder();
    const dialog = await openEdit(page, placeholder.name);
    await emailField(dialog).fill(address);
    await saveButton(dialog).click();
    return { dialog, ...placeholder };
  }

  for (const [who, userOf] of [
    ["a joined member's", () => scope.memberUserId],
    ["the leader's own", () => scope.userId],
  ] as const) {
    test(`${who} address: «alreadyMember» on the field, the typing kept, the row unchanged, nothing mailed`, async ({
      page,
    }) => {
      // Kills: sending the refusal to the toast instead of the `email` field.
      const address = await addressOf(userOf());
      const mails = await mailCount(address);
      const before = await rosterCount();
      const { dialog, id, name } = await submitAddress(page, address);

      await expectFieldRefusal(dialog, alreadyMember, address, name);
      expect(await stored(id)).toEqual({ name, invite_email: null, user_id: null });
      expect(await rosterCount()).toBe(before + 1);
      expect(await mailCount(address)).toBe(mails);
    });
  }

  test("an address on a domain that takes no mail: «domainUndeliverable» on the field, nothing written", async ({
    page,
  }) => {
    // Kills: leaving `errors.domainUndeliverable` out of the field list (it falls to the toast).
    const address = `x-${randomUUID()}@example.com`;
    const { dialog, id, name } = await submitAddress(page, address);
    try {
      await expectFieldRefusal(dialog, undeliverable, address, name);
      expect(await stored(id)).toEqual({ name, invite_email: null, user_id: null });
      expect(await listed(address)).toBe(0);
      expect(await fixtureSql`select 1 from auth.users where email = ${address}`).toHaveLength(0);
      expect(await mailCount(address)).toBe(0);
    } finally {
      await forget(address, { sent: false });
    }
  });

  test("another pending row's address: «emailTaken» on the field, the row unchanged, nothing mailed", async ({
    page,
  }) => {
    // Kills: the taken refusal falling to the toast.
    const address = freshAddress();
    await seedPending(`Pendiente ${stamp}`, address);
    try {
      const { dialog, id, name } = await submitAddress(page, address);

      await expectFieldRefusal(dialog, emailTaken, address, name);
      expect(await stored(id)).toEqual({ name, invite_email: null, user_id: null });
      expect(await mailCount(address)).toBe(0);
    } finally {
      await forget(address, { sent: false });
    }
  });

  for (const [title, words, address] of [
    ["a live member's address", alreadyMember, () => addressOf(scope.memberUserId)],
    ["an undeliverable domain", undeliverable, async () => `x-${randomUUID()}@example.com`],
    ["a taken address", emailTaken, async () => {
      const taken = freshAddress();
      await seedPending(`Pendiente ${stamp}`, taken);
      return taken;
    }],
  ] as const) {
    test(`${title}: the words show once, on the field, and no toast repeats them`, async ({ page }) => {
      // Kills: dropping the `return` after `setError` (the toast fires as well).
      await recordToasts(page);
      const typed = await address();
      try {
        const { dialog } = await submitAddress(page, typed);

        await expect(emailGroup(dialog).getByText(words, { exact: true })).toBeVisible();
        await twoFrames(page);
        expect((await toastsSeen(page)).filter((text) => text.includes(words))).toEqual([]);
        await expect(page.getByText(words, { exact: true })).toHaveCount(1);
      } finally {
        // A live member's address is a harness identity: only the addresses this test minted are dropped.
        if (typed !== (await addressOf(scope.memberUserId))) await forget(typed, { sent: false });
      }
    });
  }

  test("after a field refusal «Cancelar» closes the dialog and sends no further request", async ({ page }) => {
    // Kills: submitting on close.
    const posts = actionPosts(page);
    const address = await addressOf(scope.memberUserId);
    const { dialog, id, name } = await submitAddress(page, address);
    await expect(emailGroup(dialog).getByText(alreadyMember, { exact: true })).toBeVisible();
    expect(posts).toHaveLength(1);

    await cancelButton(dialog).click();

    await expect(dialog).toHaveCount(0);
    await twoFrames(page);
    expect(posts).toHaveLength(1);
    expect(await stored(id)).toEqual({ name, invite_email: null, user_id: null });
  });
});

test.describe("360 and 1280: the field opens from either band's menu", () => {
  test("the dialog draws the field in the project's own band and the page does not scroll sideways", async ({
    page,
  }, testInfo) => {
    // Kills: passing `invitable` from one band only (the other band's menu opens a dialog with no field).
    const width = testInfo.project.name === "mobile" ? 360 : 1280;
    expect(page.viewportSize()?.width).toBe(width);
    const { name } = await seedPlaceholder();
    const dialog = await openEdit(page, name);

    await expect(emailField(dialog)).toBeVisible();
    await expect(dialog.getByText(members.emailHint, { exact: true })).toBeVisible();
    const frame = (await dialog.boundingBox())!;
    const field = (await emailField(dialog).boundingBox())!;
    expect(field.x).toBeGreaterThanOrEqual(frame.x);
    expect(field.x + field.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a refusal's words wrap inside the dialog without scrolling the page sideways", async ({ page }) => {
    // Kills: a refusal line that does not wrap (the longest sentence is /login's).
    const placeholder = await seedPlaceholder();
    const address = `x-${randomUUID()}@example.com`;
    const dialog = await openEdit(page, placeholder.name);
    try {
      await emailField(dialog).fill(address);
      await saveButton(dialog).click();
      const message = emailGroup(dialog).getByText(undeliverable, { exact: true });
      await expect(message).toBeVisible();

      const box = (await message.boundingBox())!;
      const frame = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(frame.x);
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await forget(address, { sent: false });
    }
  });
});
