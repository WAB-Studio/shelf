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

import { expect, type Locator, type Page, type Route } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { HARNESS_MEMBER_EMAIL } from "../scripts/harness/session";
import { MEMBER_STORAGE_STATE, clearGroup, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const INVITER = `Carlos ${stamp}`;
const FUND = `Casa ${stamp}`;
const OTHER_FUND = `Familia Ruiz ${stamp}`;

let groupId = "";
let pendingId = "";

function claimsFor(userId: string): string {
  return JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
}

// The first identity leads FUND; the second is invited to it by email and belongs to nothing yet.
async function seedInvitation(email: string = HARNESS_MEMBER_EMAIL): Promise<void> {
  await clearGroup();
  groupId = randomUUID();
  pendingId = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(scope.userId)}, true)`;
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
const goAccounts = (page: Page) => page.getByRole("button", { name: "Ir a mis cuentas", exact: true });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function openCard(page: Page) {
  await page.goto("/es");
  await expect(heading(page, `${INVITER} te invitó a su fondo «${FUND}»`)).toBeVisible();
}

function isAction(route: Route): boolean {
  const request = route.request();
  return request.method() === "POST" && "next-action" in request.headers();
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

  test("the buttons fill the card's width (full-width Aceptar)", async ({ page }) => {
    // Kills: an Aceptar that hugs its text.
    await openCard(page);
    const card = heading(page, `${INVITER} te invitó a su fondo «${FUND}»`).locator("xpath=ancestor::*[contains(@class,'rt-Card')][1]");
    const cardBox = (await card.boundingBox())!;
    const buttonBox = (await accept(page).boundingBox())!;
    expect(buttonBox.width).toBeGreaterThan(cardBox.width * 0.7);
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

  test("accepting: both buttons are disabled and Aceptar reads «Aceptando…» while the action runs", async ({ page }) => {
    // Kills: a card that stays tappable mid-request (a double tap accepts twice); a label that never changes.
    await openCard(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/*", async (route) => {
      if (!isAction(route)) return route.fallback();
      await held;
      await route.continue();
    });

    await accept(page).click();

    const accepting = page.getByRole("button", { name: "Aceptando…", exact: true });
    await expect(accepting).toBeVisible();
    await expect(accepting).toBeDisabled();
    await expect(decline(page)).toBeDisabled();
    expect((await memberRow()).invite_state).toBe("pending");

    release();
    await expect(toastWith(page, `Ya eres parte de «${FUND}».`)).toBeVisible();
  });

  test("no longer live: withdrawn by the leader before the tap, the card says so and joins nothing", async ({ page }) => {
    // Kills: an accept that ignores a withdrawn row; the refusal missing the inviter and fund; no way out.
    await openCard(page);
    await fixtureSql`update group_members set archived_at = now() where id = ${pendingId}`;

    await accept(page).click();

    await expect(heading(page, "Esta invitación ya no está vigente")).toBeVisible();
    await expect(
      page.getByText(
        `${INVITER} la retiró o ya pasó. Si quieres unirte a «${FUND}», pídele que te invite otra vez.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(goAccounts(page)).toBeVisible();
    await expect(accept(page)).toHaveCount(0);
    await expect(decline(page)).toHaveCount(0);
    expect(await liveMembershipsOfInvitee()).toBe(0);

    await goAccounts(page).click();
    await expect(page.getByText("Invitación", { exact: true })).toHaveCount(0);
    await expect(page).not.toHaveURL(/invit/i);
  });

  test("no longer live: declining a withdrawn invitation shows the same card", async ({ page }) => {
    // Kills: a Rechazar that toasts success over a row that is already gone.
    await openCard(page);
    await fixtureSql`update group_members set archived_at = now() where id = ${pendingId}`;

    await decline(page).click();

    await expect(heading(page, "Esta invitación ya no está vigente")).toBeVisible();
    await expect(toastWith(page, "Rechazaste la invitación")).toHaveCount(0);
  });

  test("alone in their own fund: the invitee still sees the normal pending card with Aceptar", async ({ page }) => {
    // Kills: refusing the card to anyone who already leads a fund (Q32: a lone leader may accept; M81 owns the outcome).
    const aloneId = randomUUID();
    await fixtureSql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${claimsFor(scope.memberUserId)}, true)`;
      await tx`insert into groups (id, name, cash_mode) values (${aloneId}, ${OTHER_FUND}, 'per_member')`;
      await tx`
        insert into group_members (group_id, user_id, name, role)
        values (${aloneId}, ${scope.memberUserId}, ${`Ruiz ${stamp}`}, 'leader')`;
    });

    await openCard(page);
    await expect(accept(page)).toBeEnabled();
    await expect(decline(page)).toBeEnabled();
    await expect(heading(page, `Ya estás en el fondo «${OTHER_FUND}»`)).toHaveCount(0);
  });

  test("already in another fund: the card names the other fund and joins nothing", async ({ page }) => {
    // Kills: an accept that moves the person; the refusal naming the wrong fund; no way out.
    await openCard(page);
    const otherId = randomUUID();
    await fixtureSql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${claimsFor(scope.memberUserId)}, true)`;
      await tx`insert into groups (id, name, cash_mode) values (${otherId}, ${OTHER_FUND}, 'per_member')`;
      await tx`
        insert into group_members (group_id, user_id, name, role)
        values (${otherId}, ${scope.memberUserId}, ${`Ruiz ${stamp}`}, 'leader')`;
      // Someone else lives in it: a fund with company is not given up by an accept (Q32).
      await tx`
        insert into group_members (group_id, name, role)
        values (${otherId}, ${`Hermana ${stamp}`}, 'member')`;
    });

    await accept(page).click();

    await expect(heading(page, `Ya estás en el fondo «${OTHER_FUND}»`)).toBeVisible();
    await expect(
      page.getByText(
        `Se puede estar en un solo fondo. Para unirte a «${FUND}», sal primero de «${OTHER_FUND}» desde «Grupo».`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(goAccounts(page)).toBeVisible();
    await expect(accept(page)).toHaveCount(0);

    const row = await memberRow();
    expect(row.user_id).toBeNull();
    expect(row.invite_state).toBe("pending");
    const [{ n }] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from group_members where user_id = ${scope.memberUserId} and group_id = ${groupId}`;
    expect(n).toBe(0);
  });
});

test.describe("a person with no invitation never sees the card", () => {
  const cardWords = /te invitó a su fondo|Aceptando|Esta invitación ya no está vigente/;

  test("nothing pending for this address", async ({ page }) => {
    // Kills: a card shown to everyone.
    await clearGroup();
    await page.goto("/es");
    await expect(page).toHaveURL(/\/es$/);
    await expect(page.getByRole("heading", { name: "Inicio", exact: true }).or(page.locator("main")).first()).toBeVisible();
    await expect(page.getByText("Invitación", { exact: true })).toHaveCount(0);
    await expect(page.getByText(cardWords)).toHaveCount(0);
  });

  test("an invitation addressed to someone else is not shown", async ({ page }) => {
    // Kills: matching the pending row by anything looser than the signed-in address.
    await seedInvitation(`harness-other-${randomUUID()}@example.invalid`);
    await page.goto("/es");
    await expect(page.getByText(cardWords)).toHaveCount(0);
    await expect(page.getByText(INVITER)).toHaveCount(0);
  });

  test("a declined invitation is not shown again", async ({ page }) => {
    // Kills: listing archived invitations.
    await seedInvitation();
    await fixtureSql`
      update group_members set archived_at = now(), invite_state = 'declined' where id = ${pendingId}`;
    await page.goto("/es");
    await expect(page.getByText(cardWords)).toHaveCount(0);
  });
});
