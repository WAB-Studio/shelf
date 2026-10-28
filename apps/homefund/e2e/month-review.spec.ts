/**
 * «Revisar el mes» (RF-155): a closed month's items by the fixed rules, each
 * marked «Está bien» or corrected. The month seeded here sits thirty months
 * back, where no other spec writes, so its items are only this spec's.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";
import { addCivilMonths, currentMonthStart } from "@/lib/dates";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);
const month = addCivilMonths(currentMonthStart(), -30).slice(0, 7);
const before = (n: number) => addCivilMonths(`${month}-01`, -n).slice(0, 7);
const categoryId = randomUUID();
const accountId = randomUUID();
const accountName = `Cuenta revisión ${stamp}`;
let movements: string[] = [];
const ids: Record<"big" | "twinA" | "twinB" | "words", string> = { big: "", twinA: "", twinB: "", words: "" };

async function spend(
  tx: Parameters<Parameters<typeof asHarnessUser>[0]>[0],
  cents: number,
  day: string,
  category: string,
  fromWords = false,
): Promise<string> {
  const [movement] = await tx<{ id: string }[]>`
    insert into transactions (from_account_id, amount_cents, occurred_at, description, amount_from_words)
    values (${accountId}, ${cents}, ${day}, ${`Revisión ${stamp}`}, ${fromWords})
    returning id`;
  await tx`insert into transaction_splits (transaction_id, category_id, amount_cents) values (${movement.id}, ${category}, ${cents})`;
  movements.push(movement.id);
  return movement.id;
}

test.beforeEach(async () => {
  await asHarnessUser(async (tx) => {
    // Opened before the history: no movement may predate its account (RF-162).
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${scope.userId}, ${accountName}, 'asset', 'bank', 0, ${`${before(7)}-01`})`;
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${scope.userId}, ${`Mercado ${stamp}`}, 'expense', '#8C4A4A')`;
    // Three months of a usual 100.000, then 400.000: far above it.
    for (const n of [4, 3, 2]) await spend(tx, 10_000_000, `${before(n)}-10`, categoryId);
    ids.big = await spend(tx, 40_000_000, `${month}-10`, categoryId);
    ids.twinA = await spend(tx, 5_000_000, `${month}-15`, scope.categoryId);
    ids.twinB = await spend(tx, 5_000_000, `${month}-15`, scope.categoryId);
    ids.words = await spend(tx, 2_500_000, `${month}-20`, scope.categoryId, true);
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from transactions where id in ${fixtureSql(movements)}`;
  await fixtureSql`delete from categories where id = ${categoryId}`;
  await fixtureSql`delete from accounts where id = ${accountId}`;
  movements = [];
});

const okButtons = (page: Page) => page.getByRole("button", { name: "Está bien" });

for (const width of [360, 1280]) {
  test(`at ${width} the month lists one item per rule, a twin once, each «Corregir» into its movement`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/es/reports/review?month=${month}`);
    await expect(page.getByRole("heading", { level: 1, name: /^Revisar / })).toBeVisible();
    await expect(page.getByText("Muy por encima de lo usual")).toBeVisible();
    await expect(page.getByText("Lo usual: $ 100.000")).toBeVisible();
    await expect(page.getByText("Dos iguales el mismo día")).toHaveCount(1);
    await expect(page.getByText("2 movimientos iguales")).toBeVisible();
    await expect(page.getByText("Monto leído de palabras")).toBeVisible();
    await expect(okButtons(page)).toHaveCount(3);
    const fixes = page.getByRole("link", { name: "Corregir" });
    await expect(fixes).toHaveCount(3);
    const hrefs = await fixes.evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(hrefs.sort()).toEqual(
      [`/es/movements/${ids.big}`, `/es/movements/${[ids.twinA, ids.twinB].sort()[0]}`, `/es/movements/${ids.words}`].sort(),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("«Está bien» moves the item under «Revisados», a reload keeps it, and the last one reads «Revisaste»", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${month}`);
  await expect(okButtons(page)).toHaveCount(3);
  await okButtons(page).first().click();
  await expect(okButtons(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Revisados (1)" })).toBeVisible();
  await page.reload();
  await expect(okButtons(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Revisados (1)" })).toBeVisible();

  await okButtons(page).first().click();
  await expect(okButtons(page)).toHaveCount(1);
  await okButtons(page).first().click();
  await expect(page.getByText(/^Revisaste /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisados (3)" })).toBeVisible();
});

test("a month with nothing standing out says so; this month and a malformed one land on last month", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${before(1)}`);
  await expect(page.getByText(/^Nada sobresale en /)).toBeVisible();
  for (const param of [currentMonthStart().slice(0, 7), "nada"]) {
    await page.goto(`/es/reports/review?month=${param}`);
    await expect(page).toHaveURL(/\/es\/reports\/review$/);
  }
});

test("‹ › step between the seeded month and its neighbours, and «Reportes» leads to the review", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${month}`);
  await expect(page.getByRole("link", { name: "‹ mes anterior" })).toHaveAttribute(
    "href",
    `/es/reports/review?month=${before(1)}`,
  );
  await expect(page.getByRole("link", { name: "mes siguiente ›" })).toHaveAttribute(
    "href",
    `/es/reports/review?month=${addCivilMonths(`${month}-01`, 1).slice(0, 7)}`,
  );
  await page.goto("/es/reports");
  await expect(page.getByRole("link", { name: "Revisar el mes" }).locator("visible=true")).toHaveAttribute(
    "href",
    "/es/reports/review",
  );
});
