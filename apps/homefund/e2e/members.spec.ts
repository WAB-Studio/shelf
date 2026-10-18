/**
 * RF-59 and RF-11 on the roster, driven the way a person reaches them. Both were
 * proved once in a throwaway script; this is what will catch them tomorrow.
 *
 * The transfer is a swap nothing on screen can show in one place: the badge moves
 * to the other person and the caller's own row loses everything but the rename,
 * while the two `role` columns change in the same statement. Both halves are
 * asserted, and the columns are read from Postgres rather than inferred from the
 * screen that ordered the change.
 *
 * The delete refusal is the other direction: RF-11 says a member whose person left
 * an economic trace is archived, never deleted, and the only proof that holds is
 * a confirmed delete that answers in words and leaves the row where it was.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  LEADER_MEMBER_NAME,
  MEMBER_STORAGE_STATE,
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
const nav = messages.nav;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

// The menu names the row it belongs to, so a row is reached by its own name and
// never by a position among whatever else the roster is carrying.
function rowMenu(page: Page, name: string): Locator {
  return page.getByRole("button", {
    name: common.actionsFor.replace("{name}", name),
    exact: true,
  });
}

// The band the width displays. The laptop's table and the phone's cards are both
// in the DOM at every width, cut apart by CSS alone, so a locator that names no
// band reaches a member twice and dies on strict mode.
function band(page: Page): Locator {
  return page.locator("main > div > .rt-Box").filter({ visible: true });
}

// The line a member's name sits on, badges included. The laptop's table splits
// a member across cells — the role badge sits in its own column, apart from the
// name — so only the whole `role="row"` carries both; the phone's card keeps
// every badge in the one div the name sits in, and the table matches nothing
// there for `getByRole` to find, so the card's own div takes over. Waits for
// the roster's own copy of the name first, scoped to the band, never to
// `page`: the sidebar carries the caller's own name too, already visible
// before the roster paints, and a page-wide wait would resolve on that one and
// race the count below into the wrong branch — the mobile sidebar hides it
// outright, so the same wait would just hang.
async function nameRow(page: Page, name: string): Promise<Locator> {
  await band(page).getByText(name).first().waitFor();

  const row = page
    .getByRole("table", { name: members.title })
    .getByRole("row")
    .filter({ hasText: name });
  if ((await row.count()) > 0) return row;

  return band(page).locator("div").filter({ hasText: name }).last();
}

// The labels an open row menu offers, which is what says who may do what (RF-100,
// RF-59). Closing it again leaves the next row's menu reachable.
async function menuItems(page: Page, name: string): Promise<string[]> {
  await rowMenu(page, name).click();
  const items = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  return items.map((item) => item.trim());
}

/** Runs a row's menu item through the confirmation it raises. */
async function confirmThroughMenu(
  page: Page,
  name: string,
  menuItem: string,
  confirmLabel: string,
): Promise<Locator> {
  await rowMenu(page, name).click();
  await page.getByRole("menuitem", { name: menuItem, exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();

  return dialog;
}

// Both roles of the seeded group, keyed by the user holding them.
async function rolesByUser(groupId: string): Promise<Record<string, string>> {
  const rows = await fixtureSql<{ user_id: string; role: string }[]>`
    select user_id, role from group_members
    where group_id = ${groupId} and user_id is not null`;

  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

let groupId = "";

// Every test starts from the seeded roster: the first one moves the role off the
// harness user, and the rest need it back.
test.beforeEach(async () => {
  ({ groupId } = await seedGroup());
});

test.afterAll(async () => {
  await clearGroup();
});

test("moves the leader role to the member a leader picks, and steps the caller down", async ({
  page,
}) => {
  const before = await rolesByUser(groupId);
  expect(before[scope.userId]).toBe("leader");
  expect(before[scope.memberUserId]).toBe("member");

  await page.goto("/es/settings/members");
  await expect(await nameRow(page, LEADER_MEMBER_NAME)).toContainText(
    members.ownerBadge,
  );

  await rowMenu(page, PLAIN_MEMBER_NAME).click();
  await page
    .getByRole("menuitem", { name: members.transfer, exact: true })
    .click();

  // A person about to stop leading has to read that before they press (RF-59).
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(members.transferDescription);
  await dialog
    .getByRole("button", { name: members.transfer, exact: true })
    .click();

  await expect(page.getByText(members.transferred, { exact: true })).toBeVisible();

  // The swap, from the columns and not from the screen that ordered it: one call
  // raised the target and lowered the caller, and the group holds one leader.
  await expect
    .poll(async () => await rolesByUser(groupId))
    .toEqual({ [scope.userId]: "member", [scope.memberUserId]: "leader" });

  await expect(await nameRow(page, PLAIN_MEMBER_NAME)).toContainText(
    members.ownerBadge,
  );
  await expect(await nameRow(page, LEADER_MEMBER_NAME)).not.toContainText(
    members.ownerBadge,
  );

  // The caller leads nothing now, so their own row is the only one with a menu
  // and all it still offers is the rename.
  await expect(rowMenu(page, PLAIN_MEMBER_NAME)).toHaveCount(0);
  expect(await menuItems(page, LEADER_MEMBER_NAME)).toEqual([common.edit]);
  await expect(page.getByText(members.transfer, { exact: true })).toHaveCount(0);
});

test("names the one fund the caller belongs to and offers no way to a second", async ({
  page,
}) => {
  const [fund] = await fixtureSql<{ name: string }[]>`
    select name from groups where id = ${groupId}`;

  await page.goto("/es/settings/members");

  // RF-55: a membership is exclusive, so the shell has one fund to name. Two
  // surfaces carry it — the sidebar's row and the phone's header — and CSS shows
  // whichever this viewport is; a switcher would be a third.
  await expect(page.getByText(fund.name, { exact: true })).toHaveCount(2);
  await expect(
    page.getByText(fund.name, { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);

  // The one control on that row goes to this fund's own settings, not to another.
  await expect(page.getByLabel(nav.fundSettings)).toHaveAttribute(
    "href",
    "/es/settings/group",
  );
});

test.describe("under a plain member", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("offers the transfer on no row of the roster", async ({ page }) => {
    await page.goto("/es/settings/members");
    await expect(
      band(page).getByText(LEADER_MEMBER_NAME, { exact: true }),
    ).toBeVisible();

    // Two rows, one menu: only their own, and only to rename it (RF-100).
    await expect(rowMenu(page, LEADER_MEMBER_NAME)).toHaveCount(0);
    expect(await menuItems(page, PLAIN_MEMBER_NAME)).toEqual([common.edit]);
    await expect(page.getByText(members.transfer, { exact: true })).toHaveCount(0);
  });
});

test("refuses to delete a member whose person owns an account, and says so", async ({
  page,
}) => {
  const accountId = randomUUID();
  const claims = JSON.stringify({
    sub: scope.memberUserId,
    role: "authenticated",
    aud: "authenticated",
  });

  // The account belongs to the second identity, which is the row the leader is
  // about to try to delete. Written under its own claims so the stamping triggers
  // see them; the purge only reaches the first identity, so this spec drops it.
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype,
        initial_balance_cents, initial_balance_on)
      values (
        ${accountId}, ${scope.memberUserId}, ${`Cuenta del miembro ${stamp}`},
        'asset', 'bank', 1000000, (now() at time zone ${TIME_ZONE})::date)`;
  });

  const [target] = await fixtureSql<{ id: string; archived_at: string | null }[]>`
    select id, archived_at::text as archived_at from group_members
    where group_id = ${groupId} and user_id = ${scope.memberUserId}`;

  await page.goto("/es/settings/members");
  const dialog = await confirmThroughMenu(
    page,
    PLAIN_MEMBER_NAME,
    common.delete,
    common.delete,
  );

  // RF-11: the refusal is copy a person can act on, not a database message.
  await expect(page.getByText(errors.memberHasHistory, { exact: true })).toBeVisible();

  // A refused confirmation stays open, which is what keeps the roster under an
  // `aria-hidden` a role locator would not reach.
  await dialog.getByRole("button", { name: common.cancel, exact: true }).click();
  await expect(dialog).toBeHidden();

  // And the row is where it was, on screen and in Postgres, archived_at included:
  // a refusal that quietly archived instead would read the same on screen.
  await expect(
    band(page).getByText(PLAIN_MEMBER_NAME, { exact: true }),
  ).toBeVisible();
  const survivors = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from group_members where id = ${target.id}`;
  expect(survivors).toHaveLength(1);
  expect(survivors[0].archived_at).toBe(target.archived_at);

  await fixtureSql`delete from accounts where id = ${accountId}`;
});

// RF-148: the create dialog tells the leader when the invitation mail did not go. The dialog asks
// for a name alone, so the answer is the only thing that can say `inviteEmailFailed: true`; the
// action's real response is fetched and its flag rewritten on the way back.
async function addMember(page: Page, name: string, flag: boolean | null) {
  if (flag !== null) {
    await page.route("**/settings/members", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        return route.fallback();
      }
      const response = await route.fetch();
      const body = (await response.text()).replace(
        /"inviteEmailFailed":(true|false)/,
        `"inviteEmailFailed":${flag}`,
      );
      return route.fulfill({ response, body });
    });
  }
  await page.goto("/es/settings/members");
  await page
    .getByRole("button", { name: members.add, exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(members.nameLabel).fill(name);
  await dialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());

  return dialog;
}

const toastsOf = (page: Page) => page.locator("[data-sonner-toast]");

for (const [title, flag, warned] of [
  ["a failed invitation mail raises the warning once", true, true],
  ["a sent invitation mail raises none", false, false],
  ["a create with no address raises none", null, false],
] as const) {
  test(`${title}, and the dialog still closes with the member listed`, async ({ page }) => {
    // Kills: dropping the branch; toasting unconditionally; returning early on the warning.
    const name = `Invitada ${stamp}`;
    const dialog = await addMember(page, name, flag);

    await expect(page.getByText(members.created, { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(await nameRow(page, name)).toBeVisible();
    const warning = toastsOf(page).filter({ hasText: messages.onboarding.inviteStep.emailFailed });
    await expect(warning).toHaveCount(warned ? 1 : 0);
  });
}

// RF-149: «Añadir miembro» takes an optional address, and with one it invites (RF-148) and lists.
// Every address here is `harness-m2-<uuid>@example.invalid`: it goes to the local stack's inbox
// only, and the `auth.users` row a send mints is registered under the run and dropped by address.
const MAILBOX = "http://127.0.0.1:54324";
const inviteStepWarning = messages.onboarding.inviteStep.emailFailed;

function freshAddress(): string {
  return `harness-m2-${randomUUID()}@example.invalid`;
}

let memberSeq = 0;
function freshName(): string {
  memberSeq += 1;
  return `Nuevo ${stamp} ${memberSeq}`;
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

// `sent: false` for an address seeded as a roster row, which no send ever followed.
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

async function rowsWithAddress(email: string) {
  return fixtureSql<{ name: string; invite_email: string | null }[]>`
    select name, invite_email from group_members
    where group_id = ${groupId} and lower(invite_email) = ${email.toLowerCase()}`;
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

async function openCreate(page: Page): Promise<Locator> {
  await page.goto("/es/settings/members");
  await page
    .getByRole("button", { name: members.add, exact: true })
    .filter({ visible: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const nameField = (dialog: Locator) => dialog.getByLabel(members.nameLabel, { exact: true });
const emailField = (dialog: Locator) => dialog.getByLabel(members.emailLabel, { exact: true });
const saveButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: common.save, exact: true });
const cancelButton = (dialog: Locator) =>
  dialog.getByRole("button", { name: common.cancel, exact: true });
const warningsOf = (page: Page) =>
  page.locator("[data-sonner-toast]").filter({ hasText: inviteStepWarning });

// A pending member, written the way the invite writes it, without sending anything.
async function seedPending(name: string, email: string) {
  await asHarnessUser(async (tx) => {
    await tx`
      insert into group_members (group_id, name, role, invite_email)
      values (${groupId}, ${name}, 'member', ${email})`;
  });
}

// The new row as the leader reads it: the name, «Invitación pendiente», and the address,
// in whichever band the width displays (the table at 1280, the cards at 360).
async function expectPendingRow(page: Page, name: string, email: string) {
  const row = await nameRow(page, name);
  await expect(row).toContainText(members.pendingBadge);
  await expect(band(page).getByText(email, { exact: true })).toBeVisible();
  // The address sits with the name in one row or card, not elsewhere on the page.
  await expect(
    band(page).locator("div, tr").filter({ hasText: name }).filter({ hasText: email }).first(),
  ).toBeVisible();
}

test.describe("RF-149: adding a member with an optional address", () => {
  test("the create dialog opens on «Nombre», with «Correo (opcional)» empty and its hint", async ({
    page,
  }) => {
    // Kills: omitting the field; focus moved off the name; the hint dropped; a field that is not an email input.
    const dialog = await openCreate(page);

    await expect(nameField(dialog)).toBeFocused();
    const email = emailField(dialog);
    await expect(email).toBeVisible();
    await expect(email).toHaveValue("");
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("id", "member-email");
    await expect(email).toHaveAttribute("autocomplete", "off");
    await expect(dialog.getByText(members.emailHint, { exact: true })).toBeVisible();
  });

  test("«Editar miembro» has no address field", async ({ page }) => {
    // Kills: showing the address field on edit.
    await page.goto("/es/settings/members");
    await rowMenu(page, PLAIN_MEMBER_NAME).click();
    await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
    const dialog = page.getByRole("dialog");

    await expect(dialog.getByRole("heading", { name: members.editTitle })).toBeVisible();
    await expect(nameField(dialog)).toBeVisible();
    await expect(dialog.getByLabel(members.emailLabel)).toHaveCount(0);
    await expect(dialog.getByText(members.emailHint, { exact: true })).toHaveCount(0);
  });

  test("a malformed address is refused on the field and no request leaves", async ({ page }) => {
    // Kills: the email dropped from the client schema path (a malformed address goes to the server).
    const posts = actionPosts(page);
    const dialog = await openCreate(page);

    await nameField(dialog).fill(freshName());
    await emailField(dialog).fill("ana@");
    await saveButton(dialog).click();

    await expect(dialog.getByText(members.errors.emailInvalid, { exact: true })).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  test("while saving, both fields and both buttons are disabled and «Guardar» spins", async ({
    page,
  }) => {
    // Kills: leaving the address field enabled while pending; dropping the spinner.
    const email = freshAddress();
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
    const dialog = await openCreate(page);
    const name = freshName();
    try {
      await nameField(dialog).fill(name);
      await emailField(dialog).fill(email);
      await saveButton(dialog).click();

      await expect(nameField(dialog)).toBeDisabled();
      await expect(emailField(dialog)).toBeDisabled();
      await expect(cancelButton(dialog)).toBeDisabled();
      await expect(saveButton(dialog)).toBeDisabled();
      await expect(saveButton(dialog).locator(".rt-Spinner")).toBeVisible();
    } finally {
      release();
      await expect(dialog).toHaveCount(0);
      await register(email);
      await forget(email);
    }
  });

  test("«Cancelar» closes the dialog and sends nothing: no request, no row, no mail", async ({
    page,
  }) => {
    // Kills: submitting on close.
    const email = freshAddress();
    const name = freshName();
    const posts = actionPosts(page);
    const dialog = await openCreate(page);

    await nameField(dialog).fill(name);
    await emailField(dialog).fill(email);
    await cancelButton(dialog).click();

    await expect(dialog).toHaveCount(0);
    expect(posts).toHaveLength(0);
    await expect(band(page).getByText(name)).toHaveCount(0);
    expect(await rowsWithAddress(email)).toHaveLength(0);
    expect(await mailCount(email)).toBe(0);
  });

  test("a name and a fresh address invite: the dialog closes, the row shows the badge and the address, one mail, listed", async ({
    page,
  }) => {
    // Kills: sending `{ name }` only; toasting the warning on any `data`; not listing the address.
    const email = freshAddress();
    const name = freshName();
    const dialog = await openCreate(page);
    try {
      await nameField(dialog).fill(name);
      await emailField(dialog).fill(email);
      await saveButton(dialog).click();

      await expect(page.getByText(members.created, { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expectPendingRow(page, name, email);
      expect(await warningsOf(page).count()).toBe(0);

      await register(email);
      await expect.poll(() => mailCount(email)).toBe(1);
      expect(await rowsWithAddress(email)).toEqual([{ name, invite_email: email }]);
      expect(await listed(email)).toBe(1);
    } finally {
      await forget(email);
    }
  });

  test("an address Auth already holds adds the member and raises exactly one warning", async ({
    page,
  }) => {
    // Kills: the warning branch dropped, inverted, or raised twice.
    const email = freshAddress();
    const name = freshName();
    await fixtureSql`
      insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
              'authenticated', ${email}, now(), now())`;
    await register(email);
    const dialog = await openCreate(page);
    try {
      await nameField(dialog).fill(name);
      await emailField(dialog).fill(email);
      await saveButton(dialog).click();

      await expect(page.getByText(members.created, { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(warningsOf(page)).toHaveCount(1);
      await expectPendingRow(page, name, email);
      expect(await mailCount(email)).toBe(0);
    } finally {
      await forget(email);
    }
  });

  test("a name alone adds a member with no warning, no mail, no badge and no stored address", async ({
    page,
  }) => {
    // Kills: passing "" through as an address (stored blank, a mail attempted, a warning raised).
    const name = freshName();
    const dialog = await openCreate(page);

    await nameField(dialog).fill(name);
    await saveButton(dialog).click();

    await expect(page.getByText(members.created, { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const row = await nameRow(page, name);
    await expect(row).toBeVisible();
    await expect(row).not.toContainText(members.pendingBadge);
    expect(await warningsOf(page).count()).toBe(0);
    const stored = await fixtureSql<{ invite_email: string | null }[]>`
      select invite_email from group_members where group_id = ${groupId} and name = ${name}`;
    expect(stored).toEqual([{ invite_email: null }]);
  });

  // Needs M1 (lane 2): the server refuses a second pending invitation to one address. Red until it lands.
  test("an address already invited is refused on the field, the dialog stays open and keeps it", async ({
    page,
  }) => {
    // Kills: closing the dialog on the error; clearing the address; adding a second row.
    const email = freshAddress();
    await seedPending(`Pendiente ${stamp}`, email);
    const dialog = await openCreate(page);
    try {
      await nameField(dialog).fill(freshName());
      await emailField(dialog).fill(email);
      await saveButton(dialog).click();

      await expect(dialog.getByText(members.errors.emailTaken, { exact: true })).toBeVisible();
      // `data-state` flips to "closed" the instant a close starts, before the exit animation unmounts it.
      await expect(dialog).toHaveAttribute("data-state", "open");
      await expect(emailField(dialog)).toHaveValue(email);
      expect(await rowsWithAddress(email)).toHaveLength(1);
      expect(await mailCount(email)).toBe(0);
    } finally {
      await forget(email, { sent: false });
    }
  });

  test("editing a pending member's name sends no address and keeps hers", async ({ page }) => {
    // Kills: reusing the create payload on edit.
    const email = freshAddress();
    const old = `Pendiente ${stamp}`;
    await seedPending(old, email);
    const posts = actionPosts(page);
    await page.goto("/es/settings/members");
    try {
      await rowMenu(page, old).click();
      await page.getByRole("menuitem", { name: common.edit, exact: true }).click();
      const dialog = page.getByRole("dialog");
      const renamed = `Renombrada ${stamp}`;
      await nameField(dialog).fill(renamed);
      await saveButton(dialog).click();

      await expect(page.getByText(members.updated, { exact: true })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      expect(posts).toHaveLength(1);
      expect(posts[0]).not.toContain("email");
      expect(posts[0]).not.toContain(email);
      await expectPendingRow(page, renamed, email);
      expect(await rowsWithAddress(email)).toEqual([{ name: renamed, invite_email: email }]);
      expect(await mailCount(email)).toBe(0);
    } finally {
      await forget(email, { sent: false });
    }
  });
});
