import type { BrowserContext, Page } from "@playwright/test";

import { todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { countActionPosts, holdActions, MINUTES, monthsAhead, openAs, seedGoal } from "./meta-arbol-seed";

// Module 1000 (RP-02, RP-03, RP-05, RNP-02): a write that never reaches the server writes nothing, draws
// nothing as done, leaves no control stuck and keeps what the person typed; the retry writes once.
// «Offline use» is out of scope: nothing is queued, this is only what the person sees when it fails.

type Db = Parameters<typeof seedGoal>[0];
type Person = Parameters<typeof seedGoal>[1];
type Mode = "offline" | "500";
const MODES: Mode[] = ["offline", "500"];

const TAP = "Tocar la puerta";
const QTY = "Contar pasos";
const TARGET = 10;
const TYPED = 15;

async function seed(db: Db, person: Person) {
  const goalId = await seedGoal(db, person, { name: `Sin red ${Date.now()}`, unit: MINUTES, horizon: monthsAhead(4) });
  const [tap] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goalId}, ${TAP}, 'daily', 'tap', now() - interval '60 days') returning id`;
  const [qty] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goalId}, ${QTY}, 'daily', 'quantity', ${TARGET}, 'minutos', now() - interval '60 days') returning id`;
  return { goalId, tap: tap.id, qty: qty.id };
}

async function factsOf(db: Db, commitmentId: string): Promise<{ quantity: number | null }[]> {
  return db`select quantity from goals.facts where commitment_id = ${commitmentId} and day = ${todayInZone()}::date`;
}

async function goalsNamed(db: Db, person: Person, name: string): Promise<number> {
  const rows = await db`select 1 from goals.goals where user_id = ${person.id} and name = ${name}`;
  return rows.length;
}

// Cuts the write path and returns what restores it.
async function cut(mode: Mode, context: BrowserContext, page: Page): Promise<() => Promise<void>> {
  if (mode === "offline") {
    await context.setOffline(true);
    return () => context.setOffline(false);
  }
  let refuse = true;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (refuse && request.method() === "POST" && request.headers()["next-action"]) {
      await route.fulfill({ status: 500, body: "boom" });
    } else await route.continue();
  });
  return async () => {
    refuse = false;
  };
}

// An unhandled rejection in the page surfaces as a pageerror; none may come out of a refused write.
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

// Lets a rejection that is still queued reach the page before the absence is asserted.
const quiet = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));

const markOf = (page: Page, name: string) => page.locator("button", { hasText: name }).first();

for (const mode of MODES) {
  test.describe(`write cut by ${mode}`, () => {
    test("a tap writes nothing, draws no mark, leaves the row free; the retry writes once", async ({ person, browser, baseURL, db }) => {
      const { tap } = await seed(db, person);
      const { page, context } = await openAs(browser, baseURL, person, "/");
      try {
        const errors = pageErrors(page);
        const row = markOf(page, TAP);
        await expect(row.locator("svg")).toHaveCount(0);
        const restore = await cut(mode, context, page);
        await row.click();
        await expect(row).toBeEnabled();
        await quiet(page);
        expect(errors).toEqual([]);
        await expect(page.getByText("No se pudo abrir")).toHaveCount(0);
        await expect(row.locator("svg")).toHaveCount(0);
        expect(await factsOf(db, tap)).toHaveLength(0);

        await restore();
        await row.click();
        await expect(row.locator("svg")).toBeVisible();
        expect(await factsOf(db, tap)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    test("undoing a done tap keeps the fact and the mark", async ({ person, browser, baseURL, db }) => {
      const { goalId, tap } = await seed(db, person);
      await db`insert into goals.facts (user_id, commitment_id, goal_id, day) values (${person.id}, ${tap}, ${goalId}, ${todayInZone()}::date)`;
      const { page, context } = await openAs(browser, baseURL, person, "/");
      try {
        const row = markOf(page, TAP);
        await expect(row.locator("svg")).toBeVisible();
        const errors = pageErrors(page);
        await cut(mode, context, page);
        await row.click();
        await expect(row).toBeEnabled();
        await quiet(page);
        expect(errors).toEqual([]);
        await expect(page.getByText("No se pudo abrir")).toHaveCount(0);
        await expect(row.locator("svg")).toBeVisible();
        expect(await factsOf(db, tap)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    test("the quantity sheet stays open with the number, does not fall to the error page; the retry writes once", async ({ person, browser, baseURL, db }) => {
      const { qty } = await seed(db, person);
      const { page, context } = await openAs(browser, baseURL, person, "/");
      try {
        await markOf(page, QTY).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await sheet.getByRole("button", { name: `${TYPED} min`, exact: true }).click();
        const restore = await cut(mode, context, page);
        await sheet.getByRole("button", { name: "Anotar" }).click();
        await expect(sheet.getByRole("button", { name: "Anotar" })).toBeEnabled();
        await expect(page.getByText("No se pudo abrir")).toHaveCount(0);
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole("button", { name: `${TYPED} min`, exact: true })).toHaveAttribute("aria-pressed", "true");
        expect(await factsOf(db, qty)).toHaveLength(0);

        await restore();
        await sheet.getByRole("button", { name: "Anotar" }).click();
        await expect(sheet).toBeHidden();
        const rows = await factsOf(db, qty);
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(TYPED);
      } finally {
        await context.close();
      }
    });

    test("undoing a quantity from the sheet keeps the sheet, the fact and the page", async ({ person, browser, baseURL, db }) => {
      const { goalId, qty } = await seed(db, person);
      await db`insert into goals.facts (user_id, commitment_id, goal_id, day, quantity) values (${person.id}, ${qty}, ${goalId}, ${todayInZone()}::date, ${TYPED})`;
      const { page, context } = await openAs(browser, baseURL, person, "/");
      try {
        const errors = pageErrors(page);
        await markOf(page, QTY).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await cut(mode, context, page);
        await sheet.getByRole("button", { name: "Deshacer", exact: true }).click();
        await expect(sheet.getByRole("button", { name: "Deshacer", exact: true })).toBeEnabled();
        await quiet(page);
        await expect(page.getByText("No se pudo abrir")).toHaveCount(0);
        expect(errors).toEqual([]);
        await expect(sheet).toBeVisible();
        expect(await factsOf(db, qty)).toHaveLength(1);
      } finally {
        await context.close();
      }
    });

    test("closing the sheet after a refused save writes nothing when the network returns", async ({ person, browser, baseURL, db }) => {
      const { qty } = await seed(db, person);
      const { page, context } = await openAs(browser, baseURL, person, "/");
      try {
        await markOf(page, QTY).click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        const restore = await cut(mode, context, page);
        await sheet.getByRole("button", { name: "Anotar" }).click();
        await expect(sheet.getByRole("button", { name: "Anotar" })).toBeEnabled();
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();
        await restore();
        await expect(markOf(page, QTY).locator("svg")).toHaveCount(0);
        expect(await factsOf(db, qty)).toHaveLength(0);
      } finally {
        await context.close();
      }
    });

    test("a new goal is not opened, the button comes back, the name stays; the retry opens one", async ({ person, browser, baseURL, db }) => {
      const name = `Meta sin red ${Date.now()}`;
      const { page, context } = await openAs(browser, baseURL, person, "/metas/nueva");
      try {
        await page.getByLabel("nombre").fill(name);
        const restore = await cut(mode, context, page);
        await page.getByRole("button", { name: "Abrirla" }).click();
        await expect(page.getByRole("button", { name: "Abrirla" })).toBeEnabled();
        await expect(page.getByRole("button", { name: "Abriéndola…" })).toHaveCount(0);
        await expect(page.getByLabel("nombre")).toHaveValue(name);
        expect(new URL(page.url()).pathname).toBe("/metas/nueva");
        expect(await goalsNamed(db, person, name)).toBe(0);

        await restore();
        await page.getByRole("button", { name: "Abrirla" }).click();
        await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
        expect(await goalsNamed(db, person, name)).toBe(1);
      } finally {
        await context.close();
      }
    });
  });
}

test("held in flight, two taps send one POST", async ({ person, browser, baseURL, db }) => {
  const { tap } = await seed(db, person);
  const { page, context } = await openAs(browser, baseURL, person, "/");
  try {
    const posts = countActionPosts(page);
    await holdActions(page);
    const row = markOf(page, TAP);
    await row.dispatchEvent("click");
    await row.dispatchEvent("click");
    await expect(row.locator("svg")).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(await factsOf(db, tap)).toHaveLength(1);
  } finally {
    await context.close();
  }
});
