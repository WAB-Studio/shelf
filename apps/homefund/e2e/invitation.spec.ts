/**
 * RF-154, the invited person's screen (board «Invitación», M69): «X te invitó · Aceptar / Rechazar».
 *
 * Written from the board, not from the component: every sentence is spelled out, so a changed word
 * reddens a test. The invitee is the harness's second identity, signed in by its stored session; a
 * pending row addressed to its email waits in a fund the first identity leads. The spec asserts what
 * appears, not a route: the card is reached by opening Inicio, and the people it names are read from
 * the database. Both Playwright projects run every test: the phone (360) and the laptop (1280).
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { HARNESS_MEMBER_EMAIL } from "../scripts/harness/session";
import { MEMBER_STORAGE_STATE, asUser, clearGroup, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const INVITER = `Carlos ${stamp}`;
const FUND = `Casa ${stamp}`;

let groupId = "";
let pendingId = "";

// The first identity leads FUND; the second is invited to it by email and belongs to nothing yet.
async function seedInvitation(email: string = HARNESS_MEMBER_EMAIL): Promise<void> {
  await clearGroup();
  groupId = randomUUID();
  pendingId = randomUUID();
  await asUser(scope.userId, async (tx) => {
    await tx`insert into groups (id, name, cash_mode) values (${groupId}, ${FUND}, 'per_member')`;
    await tx`
      insert into group_members (group_id, user_id, name, role)
      values (${groupId}, ${scope.userId}, ${INVITER}, 'leader')`;
    await tx`
      insert into group_members (id, group_id, name, role, invite_email)
      values (${pendingId}, ${groupId}, ${`Invitada ${stamp}`}, 'member', ${email})`;
  });
}

async function memberRow() {
  const rows = await fixtureSql<
    { user_id: string | null; invite_state: string; invite_email: string | null; archived_at: Date | null }[]
  >`select user_id, invite_state, invite_email, archived_at from group_members where id = ${pendingId}`;
  return rows[0];
}

async function liveMembershipsOfInvitee(): Promise<number> {
  const [{ n }] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from group_members where user_id = ${scope.memberUserId} and archived_at is null`;
  return n;
}

const toastWith = (page: Page, text: string): Locator =>
  page.locator("[data-sonner-toast]").filter({ hasText: text });

const accept = (page: Page) => page.getByRole("button", { name: "Aceptar", exact: true });
const decline = (page: Page) => page.getByRole("button", { name: "Rechazar", exact: true });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function openCard(page: Page) {
  await page.goto("/es");
  await expect(heading(page, `${INVITER} te invitó a su fondo «${FUND}»`)).toBeVisible();
}

test.use({ storageState: MEMBER_STORAGE_STATE });

test.afterAll(async () => {
  await clearGroup();
});

test.describe("a person with an invitation", () => {
  test.beforeEach(async () => {
    await seedInvitation();
  });

  test("pending: names the inviter and the fund, explains both choices, offers both buttons", async ({ page }) => {
    // Kills: a card that names the wrong person or fund; either sentence missing; a button missing.
    await openCard(page);
    await expect(page.getByText("Invitación", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        `Si aceptas, los miembros de «${FUND}» verán tus cuentas y movimientos personales, y tú verás los suyos y los del fondo.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        `Si rechazas, sigues con tus cuentas solo para ti. Puedes unirte más tarde si ${INVITER} te invita otra vez.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(accept(page)).toBeEnabled();
    await expect(decline(page)).toBeEnabled();

    // Opening the card joins nothing.
    expect(await liveMembershipsOfInvitee()).toBe(0);
    expect((await memberRow()).invite_state).toBe("pending");
  });

  test("accept: the membership is live, Inicio opens with the toast and the fund", async ({ page }) => {
    // Kills: an Aceptar that writes nothing; a toast with another text; landing anywhere but Inicio.
    await openCard(page);
    await accept(page).click();

    await expect(toastWith(page, `Ya eres parte de «${FUND}».`)).toBeVisible();
    await expect(page).toHaveURL(/\/es$/);
    await expect(page).toHaveTitle(FUND);
    await expect(page.getByText("Invitación", { exact: true })).toHaveCount(0);

    const row = await memberRow();
    expect(row.user_id).toBe(scope.memberUserId);
    expect(row.invite_state).toBe("accepted");
    expect(row.invite_email).toBeNull();
    expect(row.archived_at).toBeNull();
  });

  test("decline: the invitation is archived, Inicio opens personal with the toast, no membership", async ({ page }) => {
    // Kills: a Rechazar that joins; one that leaves the row pending; a toast without the inviter.
    await openCard(page);
    await decline(page).click();

    await expect(toastWith(page, `Rechazaste la invitación de ${INVITER}.`)).toBeVisible();
    await expect(page).toHaveURL(/\/es$/);
    await expect(page).not.toHaveTitle(FUND);
    await expect(page.getByText("Invitación", { exact: true })).toHaveCount(0);

    const row = await memberRow();
    expect(row.user_id).toBeNull();
    expect(row.invite_state).toBe("declined");
    expect(row.archived_at).not.toBeNull();
    expect(await liveMembershipsOfInvitee()).toBe(0);
  });
});
