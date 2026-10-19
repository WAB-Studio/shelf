/**
 * RF-154 on «Grupo»: a plain member leaves the fund from a card on the fund's settings. The confirm
 * says what stays (what she wrote in the fund) and what goes (the members' view of her personal
 * accounts); Cancelar writes nothing; while it runs both buttons are off and the confirm reads
 * «Saliendo…»; done, she lands on Inicio with the toast and her membership is archived, never
 * deleted. A leader with other members is told to hand the fund over first and nothing is written;
 * a leader alone is not offered the card. Both Playwright projects run every test.
 *
 * The words are the board's (`SalirFondo*`), not messages keys: the keys do not exist until the
 * screen does, and a spec reading them could not fail for a wrong sentence.
 *
 * Fixtures: `seedGroup` runs before each test and makes a fresh fund with the leader and the plain
 * member; `afterAll` calls `clearGroup`, which deletes every group of the two identities and their
 * memberships (archived ones included), the baseline the other specs start from, and the member's
 * personal account this spec wrote goes with `dropRows`. Rows left in the harness identities' book
 * by the leave are therefore gone before the next spec seeds its own group.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  MEMBER_STORAGE_STATE,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const scope = readScope();
const FUND = "Fondo de la prueba";

const copy = {
  card: "Salir del fondo",
  cardBody: `Lo que escribiste en «${FUND}» se queda con el fondo. Tus cuentas personales vuelven a ser solo tuyas.`,
  askTitle: `¿Salir de «${FUND}»?`,
  stays:
    "Lo que escribiste en el fondo se queda con el fondo: sus cuentas, sus movimientos y lo que anotaste en ellas.",
  goes: `Tus cuentas personales vuelven a ser solo tuyas: los miembros de «${FUND}» dejan de verlas.`,
  cancel: "Cancelar",
  leave: "Salir del fondo",
  leaving: "Saliendo…",
  refusedTitle: "No puedes salir todavía",
  refusedBody: `Eres el líder de «${FUND}». Antes de salir, pasa el liderazgo a otro miembro desde «Miembros».`,
  understood: "Entendido",
  doneToast: `Saliste de «${FUND}».`,
  doneBody: "Tus cuentas siguen contigo.",
};

let groupId = "";
const personalIds: string[] = [];

function claims(userId: string): string {
  return JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
}

async function as<T>(userId: string, fn: (tx: typeof fixtureSql) => Promise<T>): Promise<T> {
  let out!: T;
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims(userId)}, true)`;
    out = await fn(tx as unknown as typeof fixtureSql);
  });
  return out;
}

// Rows the member wrote: a fund account, a movement on it, and a personal account of her own.
async function seedMemberRows() {
  const fundAccount = randomUUID();
  const personal = randomUUID();
  const fundSecond = randomUUID();
  const movement = randomUUID();
  personalIds.push(personal);

  await as(scope.memberUserId, async (tx) => {
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${fundAccount}, ${groupId}, true, 'Cuenta del fondo salir', 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${personal}, ${scope.memberUserId}, 'Personal de quien sale', 'asset', 'bank', 0, '2026-01-01')`;
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${fundSecond}, ${groupId}, true, 'Otra cuenta del fondo', 'asset', 'bank', 0, '2026-01-01')`;
    // A transfer between two fund accounts: an income or expense would need a split and a category.
    await tx`
      insert into transactions (id, from_account_id, to_account_id, amount_cents, occurred_at, created_by, group_id, currency)
      select ${movement}, ${fundSecond}, ${fundAccount}, 10000, '2026-01-02', ${scope.memberUserId}, group_id, settlement_currency
      from accounts where id = ${fundAccount}`;
  });

  return { fundAccount, personal, movement };
}

// What the leader's session can read, under the policies: the owner connection bypasses them.
async function leaderReads(accountId: string): Promise<number> {
  const rows = await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims(scope.userId)}, true)`;
    await tx`set local role authenticated`;
    return tx<{ n: number }[]>`select count(*)::int as n from accounts where id = ${accountId}`;
  });
  return rows[0].n;
}

async function memberRows() {
  return fixtureSql<{ user_id: string; role: string; archived_at: string | null }[]>`
    select user_id, role, archived_at::text as archived_at from group_members where group_id = ${groupId}`;
}

function dialogOf(page: Page): Locator {
  return page.getByRole("alertdialog").or(page.getByRole("dialog"));
}

function cardButton(page: Page): Locator {
  return page.getByRole("main").getByRole("button", { name: copy.card, exact: true });
}

async function openConfirm(page: Page): Promise<Locator> {
  await page.goto("/es/settings/group");
  await cardButton(page).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(async () => {
  ({ groupId } = await seedGroup());
});

test.afterAll(async () => {
  await clearGroup();
  const claimsFor = scope.memberUserId;
  for (const id of personalIds) {
    await as(claimsFor, async (tx) => {
      await tx`delete from accounts where id = ${id}`;
    });
  }
});

test.describe("a plain member", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });

  test("sees the card on «Grupo» with the board's words", async ({ page }) => {
    await page.goto("/es/settings/group");
    await expect(cardButton(page)).toBeVisible();
    await expect(page.getByText(copy.cardBody, { exact: true })).toBeVisible();
  });

  test("the confirm names what stays and what goes", async ({ page }) => {
    const dialog = await openConfirm(page);

    await expect(dialog.getByText(copy.askTitle, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.stays, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.goes, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: copy.cancel, exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: copy.leave, exact: true })).toBeEnabled();
  });

  test("Cancelar writes nothing", async ({ page }) => {
    const before = await memberRows();
    const dialog = await openConfirm(page);

    await dialog.getByRole("button", { name: copy.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cardButton(page)).toBeVisible();
    await expect(page).toHaveURL(/\/es\/settings\/group$/);

    expect(await memberRows()).toEqual(before);
    expect((await memberRows()).every((row) => row.archived_at === null)).toBe(true);
  });

  test("disables both buttons and reads «Saliendo…» while it runs", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
      reached = true;
      await held;
      await route.continue();
    });

    const dialog = await openConfirm(page);
    await dialog.getByRole("button", { name: copy.leave, exact: true }).click();

    await expect.poll(() => reached).toBe(true);
    await expect(dialog.getByRole("button", { name: copy.leaving, exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: copy.cancel, exact: true })).toBeDisabled();
    // Nothing is written while the answer is held.
    expect((await memberRows()).every((row) => row.archived_at === null)).toBe(true);

    release();
    await expect(page.getByText(copy.doneToast, { exact: true })).toBeVisible();
  });

  test("leaves: lands on Inicio with the toast, keeps what she wrote in the fund, her accounts leave the leader's view", async ({
    page,
  }) => {
    const rows = await seedMemberRows();
    // The precondition that gives the last assertion meaning: today the leader reads it.
    expect(await leaderReads(rows.personal)).toBe(1);

    const dialog = await openConfirm(page);
    await dialog.getByRole("button", { name: copy.leave, exact: true }).click();

    await expect(page).toHaveURL(/\/es\/?$/);
    await expect(page.getByText(copy.doneToast, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.doneBody, { exact: true })).toBeVisible();

    const roster = await memberRows();
    const hers = roster.find((row) => row.user_id === scope.memberUserId);
    expect(hers, "the membership is archived, not deleted").toBeDefined();
    expect(hers?.archived_at).not.toBeNull();
    const leader = roster.find((row) => row.user_id === scope.userId);
    expect(leader?.archived_at).toBeNull();
    expect(leader?.role).toBe("leader");

    const [fund] = await fixtureSql<{ group_id: string | null }[]>`
      select group_id from accounts where id = ${rows.fundAccount}`;
    expect(fund?.group_id).toBe(groupId);
    const [moved] = await fixtureSql<{ group_id: string | null; created_by: string }[]>`
      select group_id, created_by from transactions where id = ${rows.movement}`;
    expect(moved?.group_id).toBe(groupId);
    expect(moved?.created_by).toBe(scope.memberUserId);

    const [own] = await fixtureSql<{ owner_user_id: string | null; group_id: string | null }[]>`
      select owner_user_id, group_id from accounts where id = ${rows.personal}`;
    expect(own?.owner_user_id).toBe(scope.memberUserId);
    expect(own?.group_id).toBeNull();

    expect(await leaderReads(rows.personal)).toBe(0);
    expect(await leaderReads(rows.fundAccount)).toBe(1);
  });
});

test.describe("a leader", () => {
  test("with other members is told to hand the fund over, and nothing is written", async ({
    page,
  }) => {
    const before = await memberRows();
    await page.goto("/es/settings/group");
    await cardButton(page).click();

    const dialog = dialogOf(page);
    await expect(dialog.getByText(copy.refusedTitle, { exact: true })).toBeVisible();
    await expect(dialog.getByText(copy.refusedBody, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: copy.understood, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: copy.leave, exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: copy.understood, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/es\/settings\/group$/);
    expect(await memberRows()).toEqual(before);
  });

  test("alone in the fund is not offered the card", async ({ page }) => {
    await fixtureSql`delete from group_members where group_id = ${groupId} and user_id = ${scope.memberUserId}`;
    expect(await memberRows()).toHaveLength(1);

    await page.goto("/es/settings/group");
    // The leader's form is the proof the screen rendered before the card is counted.
    await expect(page.getByLabel("Nombre del fondo")).toBeVisible();
    await expect(cardButton(page)).toHaveCount(0);
    await expect(page.getByText(copy.cardBody, { exact: true })).toHaveCount(0);
  });
});


