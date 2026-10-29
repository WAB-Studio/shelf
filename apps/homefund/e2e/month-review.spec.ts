/**
 * «Revisar el mes» (RF-155): a closed month's items by the fixed rules, each
 * marked «Está bien» or corrected. The month seeded here sits thirty months
 * back, where no other spec writes, so its items are only this spec's.
 */
import { randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";

import { fixtureSql } from "../scripts/harness/fixtures";
import { MEMBER_STORAGE_STATE, asHarnessUser, clearGroup, readScope, seedGroup, test } from "./global-setup";
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
    // A count of 1.010.000 the trigger books against the balance the spends left.
    const [count] = await tx<{ id: string }[]>`
      insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents, created_by)
      values (${accountId}, ${`${month}-25`}, 101_000_000, ${scope.userId}) returning id`;
    const [gap] = await tx<{ id: string }[]>`select id from transactions where reconciliation_id = ${count.id}`;
    movements.push(gap.id);
  });
});

test.afterEach(async () => {
  await fixtureSql`delete from transactions where id in ${fixtureSql(movements)}`;
  await fixtureSql`delete from account_reconciliations where account_id = ${accountId}`;
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
    await expect(page.getByText("Diferencia al cuadrar")).toBeVisible();
    await expect(page.getByText("Contaste $ 1.010.000")).toBeVisible();
    // The over-the-usual, the twin and the from-words item each name the movement they flag.
    await expect(page.getByText(`Revisión ${stamp}`, { exact: true })).toHaveCount(3);
    await expect(okButtons(page)).toHaveCount(4);
    const fixes = page.getByRole("link", { name: "Corregir" });
    await expect(fixes).toHaveCount(4);
    const hrefs = await fixes.evaluateAll((links) => links.map((a) => a.getAttribute("href")));
    expect(hrefs.sort()).toEqual(
      [
        `/es/movements/${ids.big}?review=${month}`,
        `/es/movements/${[ids.twinA, ids.twinB].sort()[0]}?review=${month}`,
        `/es/movements/${ids.words}?review=${month}`,
        "/es/settings/accounts",
      ].sort(),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // Each row stands off the panel's edge, as a panel's rows do.
    const panel = page.getByText("Muy por encima de lo usual").locator("xpath=ancestor::*[@data-variant='stack'][1]");
    const [edge, words] = await Promise.all([panel.boundingBox(), page.getByText("Muy por encima de lo usual").boundingBox()]);
    expect((words?.x ?? 0) - (edge?.x ?? 0)).toBeGreaterThanOrEqual(16);
  });
}

test("«Está bien» moves the item under «Revisados», a reload keeps it, and the last one reads «Revisaste»", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${month}`);
  await expect(okButtons(page)).toHaveCount(4);
  await okButtons(page).first().click();
  await expect(okButtons(page)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Revisados (1)" })).toBeVisible();
  await page.reload();
  await expect(okButtons(page)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Revisados (1)" })).toBeVisible();

  for (const left of [2, 1, 0]) {
    await okButtons(page).first().click();
    await expect(okButtons(page)).toHaveCount(left);
  }
  await expect(page.getByText(/^Revisaste /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revisados (4)" })).toBeVisible();
});

test("a month with nothing standing out says so, one with nothing noted says that; this month and a malformed one land on last month", async ({ page }) => {
  // The usual's history: one movement, nothing over it.
  await page.goto(`/es/reports/review?month=${before(2)}`);
  await expect(page.getByText(/^Nada sobresale en /)).toBeVisible();
  await page.goto(`/es/reports/review?month=${before(1)}`);
  await expect(page.getByText(/^No anotaste nada en /)).toBeVisible();
  await expect(page.getByText(/^Nada sobresale en /)).toHaveCount(0);
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
  // Last month is the newest closed one: no step into the open month.
  await page.goto("/es/reports/review");
  await expect(page.getByRole("link", { name: "mes siguiente ›" })).toHaveCount(0);
  await page.goto("/es/reports");
  await expect(page.getByRole("link", { name: "Revisar el mes" }).locator("visible=true")).toHaveAttribute(
    "href",
    "/es/reports/review",
  );
});

test("«Deshacer» under «Revisados» drops the mark: the item waits again, after a reload too (RF-163)", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${month}`);
  await okButtons(page).first().click();
  await expect(okButtons(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Revisados (1)" }).click();
  await page.getByRole("button", { name: "Deshacer" }).click();
  await expect(okButtons(page)).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Revisados/ })).toHaveCount(0);
  await page.reload();
  await expect(okButtons(page)).toHaveCount(4);
});

for (const width of [360, 1280]) {
  test(`at ${width} «Corregir» opens the movement whose back arrow returns to the month under review`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/es/reports/review?month=${month}`);
    await page.locator(`a[href="/es/movements/${ids.big}?review=${month}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/es/movements/${ids.big}\\?review=${month}$`));
    const back = page.getByRole("link", { name: "Revisar el mes" }).locator("visible=true");
    await expect(back).toHaveAttribute("href", `/es/reports/review?month=${month}`);
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/es/reports/review\\?month=${month}$`));
    // Left without a change: the item still waits.
    await expect(okButtons(page)).toHaveCount(4);
    // A review the page cannot read leads back to the movements.
    await page.goto(`/es/movements/${ids.big}?review=nada`);
    await expect(page.getByRole("link", { name: "Revisar el mes" })).toHaveCount(0);
  });
}

test("deleting a twin opened from «Corregir» lands back on the month, where the twin is gone", async ({ page }) => {
  await page.goto(`/es/movements/${ids.twinB}?review=${month}`);
  await page.getByRole("button", { name: "Eliminar", exact: true }).locator("visible=true").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Eliminar", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/es/reports/review\\?month=${month}$`));
  await expect(page.getByText("Dos iguales el mismo día")).toHaveCount(0);
  await expect(okButtons(page)).toHaveCount(3);
});

test("the first month keeps its page and offers no ‹, the one after steps back to it, the one before last steps into last month; a malformed month lands on last month", async ({
  page,
}) => {
  // The page's own first month: the earliest movement the harness user's policies let it read.
  let first = "";
  await asHarnessUser(async (tx) => {
    [{ first }] = await tx<{ first: string }[]>`select to_char(min(occurred_at), 'YYYY-MM') as first from transactions`;
  });
  const after = (from: string, n: number) => addCivilMonths(`${from}-01`, n).slice(0, 7);
  await page.goto(`/es/reports/review?month=${first}`);
  await expect(page).toHaveURL(new RegExp(`month=${first}$`));
  await expect(page.getByRole("link", { name: "‹ mes anterior" })).toHaveCount(0);
  await page.goto(`/es/reports/review?month=${after(first, 1)}`);
  await expect(page.getByRole("link", { name: "‹ mes anterior" })).toHaveAttribute("href", `/es/reports/review?month=${first}`);
  const lastClosed = after(currentMonthStart().slice(0, 7), -1);
  await page.goto(`/es/reports/review?month=${after(lastClosed, -1)}`);
  await expect(page.getByRole("link", { name: "mes siguiente ›" })).toHaveAttribute("href", `/es/reports/review?month=${lastClosed}`);
  // Earlier than any month and still not one: the shape alone turns it away.
  await page.goto("/es/reports/review?month=1999-xx");
  await expect(page).toHaveURL(/\/es\/reports\/review$/);
});

test.describe("as a member who only reads the leader's account", () => {
  test.use({ storageState: MEMBER_STORAGE_STATE });
  test.beforeEach(async () => {
    await seedGroup();
  });
  test.afterEach(async () => {
    await clearGroup();
  });

  test("the items show with who fixes them, and no «Está bien» nor «Corregir»", async ({ page }) => {
    await page.goto(`/es/reports/review?month=${month}`);
    await expect(page.getByText("Muy por encima de lo usual")).toBeVisible();
    await expect(page.getByText(`Lo corrige quien maneja ${accountName}.`)).toHaveCount(4);
    await expect(okButtons(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Corregir" })).toHaveCount(0);
  });
});

test("«Está bien» reads «Guardando…» and holds still while the server answers", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${month}`);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/es/reports/review?month=${month}`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !("next-action" in request.headers())) return route.fallback();
    await held;
    await route.fallback();
  });
  await okButtons(page).first().click();
  const saving = page.getByRole("button", { name: "Guardando…" });
  await expect(saving).toBeVisible();
  await expect(saving).toBeDisabled();
  release();
  await expect(okButtons(page)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Revisados (1)" })).toBeVisible();
});

test("a mark the server refuses says so in a toast and leaves the item waiting", async ({ page }) => {
  await page.goto(`/es/reports/review?month=${month}`);
  await expect(okButtons(page)).toHaveCount(4);
  // The account changes hands under the open page: the mark's policy now turns the caller away.
  await fixtureSql`update accounts set owner_user_id = ${scope.memberUserId} where id = ${accountId}`;
  await okButtons(page).first().click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "No puedes marcar este movimiento." })).toBeVisible();
  const [{ marks }] = await fixtureSql<{ marks: number }[]>`
    select count(*)::int as marks from transaction_reviews where transaction_id in ${fixtureSql(movements)}`;
  expect(marks).toBe(0);
  await expect(okButtons(page)).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Revisados/ })).toHaveCount(0);
});
