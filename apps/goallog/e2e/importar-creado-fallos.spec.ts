import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { GENERAL, SMALL, TASK_A, TASK_B, asPerson, createButton, planText, toReview } from "./importar-plan";

// RP-90, board `ImportarCreadoConFallos` (DESIGN.md, 2026-10-13, option A corrected): after «Crear»
// the review route says what was not written. Nothing here calls a model; the part that fails is a
// task whose note is blanks, which passes every check of the review and meets the table at the insert.

const KEY = "pulsar.import-draft";
const DONE = { name: "Plan creado", exact: true };
const NOT_WRITTEN = /no se escribi/i;

// The stored draft with TASK_A's note turned into blanks: the real read of the template, then a
// hand edit of the tab's storage, so the page is the one a person gets.
async function toReviewWithBrokenTask(page: Page) {
  await toReview(page, planText({ rhythm: false }));
  await page.evaluate(
    ([key, task]) => {
      const stored = JSON.parse(sessionStorage.getItem(key)!);
      let hit = 0;
      for (const goal of stored.draft.goals) for (const t of goal.tasks) if (t.name === task) { t.note = "   "; hit++; }
      if (hit !== 1) throw new Error(`expected one task named ${task}, found ${hit}`);
      sessionStorage.setItem(key, JSON.stringify(stored));
    },
    [KEY, TASK_A] as const,
  );
  await page.reload();
  await expect(createButton(page)).toBeVisible();
}

const resultRow = (page: Page) => page.getByText(TASK_A, { exact: true });

async function createWithFailure(page: Page) {
  await toReviewWithBrokenTask(page);
  await createButton(page).click();
  await expect(page.getByRole("heading", DONE)).toBeVisible();
}

test.describe("a plan created with a part that was not written (RP-90)", () => {
  test("«Crear» shows «Plan creado», the count, the part with where it went and why, and «Ir a Metas»; the rest is written", async ({ person, browser, baseURL, db }) => {
    // Kills: router.push("/metas") after a result with `failed` (the list is dropped), a missing row, a checkbox on the row.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await createWithFailure(page);
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

      // The count sentence: three goals written, one part left out.
      await expect(page.getByText(/3 metas/).filter({ hasText: /1 parte/ })).toBeVisible();

      await expect(page.getByText(NOT_WRITTEN).first()).toBeVisible();
      await expect(page.getByText(TASK_A, { exact: true })).toBeVisible();
      // The deepest element holding both the part's name and its goal: its row.
      const rowText = (await page.locator("*").filter({ hasText: TASK_A }).filter({ hasText: SMALL }).last().innerText()).trim();
      expect(rowText).toContain(SMALL);
      expect(rowText).toMatch(/nota/i);
      expect(rowText.length).toBeGreaterThan(TASK_A.length + SMALL.length + 20);

      await expect(page.getByRole("link", { name: "Ir a Metas" }).or(page.getByRole("button", { name: "Ir a Metas" }))).toBeVisible();
      expect(await page.getByRole("checkbox").count()).toBe(0);

      // What is not the broken part is in the database; the broken one is not.
      const goals = await db`select name from goals.goals where user_id = ${person.id}`;
      expect(goals.map((g) => g.name).sort()).toEqual([GENERAL, "IA aplicada", SMALL].sort());
      const tasks = await db`select name from goals.one_offs where user_id = ${person.id}`;
      expect(tasks.some((t) => t.name === TASK_A)).toBe(false);
      expect(tasks.some((t) => t.name === TASK_B)).toBe(true);
    });
  });

  test("no sentence on the result says «la tabla»", async ({ person, browser, baseURL }) => {
    // Kills: a reason written for the database's words («la tabla no acepta…») instead of a person's.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await createWithFailure(page);
      await expect(resultRow(page)).toBeVisible();
      const drawn = await page.locator("body").innerText();
      expect(drawn).not.toMatch(/tabla/i);
    });
  });

  test("a clean plan goes straight to /metas, with no «Plan creado»", async ({ person, browser, baseURL }) => {
    // Kills: always stopping on the result, even with nothing failed.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText({ rhythm: false }));
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      await expect(page.getByRole("heading", DONE)).toHaveCount(0);
      await expect(page.getByText(NOT_WRITTEN)).toHaveCount(0);
    });
  });

  test("a reload on «Plan creado» still draws the list; «Ir a Metas» goes to /metas and the review route shows no stale list afterwards", async ({ person, browser, baseURL }) => {
    // Kills: keeping the list in component state only (a reload blanks it), or never clearing it on leaving.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await createWithFailure(page);
      await page.reload();
      await expect(page.getByRole("heading", DONE)).toBeVisible();
      await expect(resultRow(page)).toBeVisible();

      await page.getByRole("link", { name: "Ir a Metas" }).or(page.getByRole("button", { name: "Ir a Metas" })).click();
      await expect(page).toHaveURL(/\/metas$/);

      await page.goto("/metas/importar/revisar");
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByRole("heading", DONE)).toHaveCount(0);
      await expect(resultRow(page)).toHaveCount(0);
      await expect(page.getByText(NOT_WRITTEN)).toHaveCount(0);
    });
  });

  test("a new tab (a new browser context) shows no list", async ({ person, browser, baseURL }) => {
    // Kills: keeping the list in localStorage or a cookie instead of the tab's own storage.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await createWithFailure(page);
      await asPerson({ person, browser, baseURL }, async (other) => {
        await other.goto("/metas/importar/revisar");
        await expect(other).toHaveURL(/\/metas\/importar$/);
        await expect(other.getByRole("heading", DONE)).toHaveCount(0);
        await expect(resultRow(other)).toHaveCount(0);
      });
      await expect(page.getByRole("heading", DONE)).toBeVisible();
    });
  });
});

