/**
 * Inicio lists the planned payments whose reminder («Recordarme el») has come
 * due, under «Por pagar» (RF-159): oldest due first, three at most, and no
 * card at all when there are none.
 *
 * Each test writes its own payments under the harness identity and drops them
 * by id. «Paid» is status `done`; «archived» is status `cancelled`, the state
 * «Cancelar pago» leaves a payment in.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";
import { todayInBogota } from "@/lib/dates";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Days from today in the person's zone, as YYYY-MM-DD.
function day(offset: number): string {
  const [y, m, d] = todayInBogota().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}

// «15 dic»: written from the table above, not from Intl.
function short(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

type Seed = {
  name: string;
  pesos: number;
  due: number;
  remind: number | null;
  status?: "pending" | "done" | "cancelled";
};

let created: string[] = [];

async function seed(rows: Seed[]): Promise<void> {
  await asHarnessUser(async (tx) => {
    for (const row of rows) {
      const id = randomUUID();
      created.push(id);
      await tx`
        insert into planned_payments (
          id, owner_user_id, from_account_id, amount_cents, due_date, remind_on,
          description, status, created_by)
        values (${id}, ${scope.userId}, ${scope.accountId}, ${row.pesos * 100},
          ${day(row.due)}, ${row.remind === null ? null : day(row.remind)},
          ${`${row.name} ${stamp}`}, ${row.status ?? "pending"}, ${scope.userId})`;
    }
  });
}

test.afterEach(async () => {
  if (created.length > 0) {
    await fixtureSql`delete from planned_payments where id in ${fixtureSql(created)}`;
  }
  created = [];
});

function rows(page: Page, name: string) {
  return page.getByRole("link").filter({ hasText: `${name} ${stamp}` });
}

function heading(page: Page) {
  return page.getByRole("heading", { name: "Por pagar", level: 2 });
}

test("due reminders list overdue first with their wording and amounts", async ({ page }) => {
  // Kills: no card, an order by reminder or name, one wording for both states, a missing amount.
  await seed([
    { name: "Luz", pesos: 234567, due: 5, remind: -1 },
    { name: "Arriendo", pesos: 876543, due: -3, remind: -10 },
  ]);
  await page.goto("/es");

  await expect(heading(page)).toBeVisible();
  const overdue = rows(page, "Arriendo");
  const upcoming = rows(page, "Luz");
  await expect(overdue).toHaveCount(1);
  await expect(upcoming).toHaveCount(1);
  await expect(overdue).toContainText(`Venció el ${short(day(-3))}`);
  await expect(overdue).toContainText("876.543");
  await expect(upcoming).toContainText(`Vence el ${short(day(5))}`);
  await expect(upcoming).not.toContainText("Venció");
  await expect(upcoming).toContainText("234.567");

  const overdueBox = await overdue.boundingBox();
  const upcomingBox = await upcoming.boundingBox();
  expect(overdueBox!.y).toBeLessThan(upcomingBox!.y);
  await expect(page.getByRole("link", { name: "Ver pagos" })).toBeVisible();
});

test("a reminder dated tomorrow is not listed", async ({ page }) => {
  // Kills: remind_on <= today read as < today + 1 day, or the reminder ignored for the due date.
  await seed([
    { name: "Hoy", pesos: 111000, due: 2, remind: 0 },
    { name: "Manana", pesos: 222000, due: 3, remind: 1 },
  ]);
  await page.goto("/es");

  await expect(rows(page, "Hoy")).toHaveCount(1);
  await expect(rows(page, "Manana")).toHaveCount(0);
});

test("a payment without a reminder is not listed", async ({ page }) => {
  // Kills: null remind_on treated as due, or the list keyed on due_date.
  await seed([
    { name: "Con aviso", pesos: 111000, due: -2, remind: -2 },
    { name: "Sin aviso", pesos: 222000, due: -5, remind: null },
  ]);
  await page.goto("/es");

  await expect(rows(page, "Con aviso")).toHaveCount(1);
  await expect(rows(page, "Sin aviso")).toHaveCount(0);
});

test("a paid or an archived payment is not listed", async ({ page }) => {
  // Kills: the status filter missing, or covering only one of done and cancelled.
  await seed([
    { name: "Pendiente", pesos: 111000, due: 1, remind: -1 },
    { name: "Pagado", pesos: 222000, due: 1, remind: -1, status: "done" },
    { name: "Archivado", pesos: 333000, due: 1, remind: -1, status: "cancelled" },
  ]);
  await page.goto("/es");

  await expect(rows(page, "Pendiente")).toHaveCount(1);
  await expect(rows(page, "Pagado")).toHaveCount(0);
  await expect(rows(page, "Archivado")).toHaveCount(0);
});

test("five due show the three oldest and the link counts all five", async ({ page }) => {
  // Kills: no limit, a limit that keeps the newest, a link that stays «Ver pagos».
  await seed([
    { name: "P5", pesos: 105000, due: 5, remind: 0 },
    { name: "P1", pesos: 101000, due: 1, remind: 0 },
    { name: "P4", pesos: 104000, due: 4, remind: 0 },
    { name: "P2", pesos: 102000, due: 2, remind: 0 },
    { name: "P3", pesos: 103000, due: 3, remind: 0 },
  ]);
  await page.goto("/es");

  for (const kept of ["P1", "P2", "P3"]) await expect(rows(page, kept)).toHaveCount(1);
  for (const cut of ["P4", "P5"]) await expect(rows(page, cut)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ver los 5" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver pagos" })).toHaveCount(0);
});

test("with none due there is no «Por pagar» card", async ({ page }) => {
  // Kills: an empty card, a heading with no rows, any one of the four filters dropped.
  await seed([
    { name: "Futuro", pesos: 111000, due: 20, remind: 10 },
    { name: "Sin aviso", pesos: 222000, due: -4, remind: null },
    { name: "Pagado", pesos: 333000, due: -4, remind: -6, status: "done" },
    { name: "Archivado", pesos: 444000, due: -4, remind: -6, status: "cancelled" },
  ]);
  await page.goto("/es");

  await expect(page.getByRole("main")).toBeVisible();
  await expect(heading(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ver pagos" })).toHaveCount(0);
});

test("a row opens Pagos on that payment", async ({ page }) => {
  // Kills: a row that is not a link, or a link to another screen.
  await seed([{ name: "Abrir", pesos: 123000, due: 2, remind: 0 }]);
  await page.goto("/es");

  await rows(page, "Abrir").click();

  await expect(page).toHaveURL(/\/es\/planning\/payments/);
  await expect(page.getByText(`Abrir ${stamp}`).filter({ visible: true }).first()).toBeVisible();
});
