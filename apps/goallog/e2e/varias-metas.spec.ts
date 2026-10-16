
import type postgres from "postgres";

import { test, expect } from "./fixtures";

// Seeded by `harness:seed-goal`, the one goal this identity always carries
// (`compromiso.spec.ts`'s own constant, word for word) — this suite never
// touches it, only ever the second goal it opens beside it.
const SEEDED_GOAL_NAME = "Inglés B1/B2 → B2+ laboral";

async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.commitments where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

test("the Metas tab opens the goals list, and a second goal is opened from it, not typed (RP-11)", async ({
  page,
  db,
  personId,
}) => {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("link", { name: "Metas", exact: true }).click();
  await page.waitForURL("**/metas");

  // The seeded goal is already listed — this list never redirects past it —
  // and its own way to open a second sits under it.
  await expect(page.getByRole("link", { name: SEEDED_GOAL_NAME })).toBeVisible();
  const addAnother = page.getByRole("link", { name: "Abrir otra meta" });
  await expect(addAnother).toBeVisible();
  await expect(addAnother).toHaveAttribute("href", "/metas/nueva");

  const goalName = `Meta segunda ${Date.now()}`;
  // The same form `compromiso.spec.ts`'s own `createGoal` drives, reached
  // here by the tap this module adds rather than by a bare `page.goto`.
  await addAnother.click();
  await page.waitForURL("**/metas/nueva");
  await page.getByLabel("nombre").fill(goalName);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  const goalId = page.url().split("/metas/")[1];

  // Below 1024px Hoy draws a section only for a goal that asks today
  //: a daily tap commitment makes the new one ask.
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goalId}, 'Tocar la segunda', 'daily', 'tap', now() - interval '3 days')`;

  try {
    // The list, with two: neither redirected past, both their own row.
    await page.goto("/metas");
    await expect(page.getByRole("link", { name: SEEDED_GOAL_NAME })).toBeVisible();
    await expect(page.getByRole("link", { name: goalName })).toBeVisible();
    await expect(page.getByRole("link", { name: "Abrir otra meta" })).toBeVisible();

    // Both open goals draw on the day (§0.3, 5), grouped, with no selector —
    // the newly opened one included once it asks something today.
    await page.goto("/");
    // A time-unit goal's name also heads its figure card (RP-35): take the section's.
    await expect(page.getByText(SEEDED_GOAL_NAME, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("main").getByText(goalName, { exact: true })).toBeVisible();

    // Its own screen has a quiet way back to the list: the bottom nav's own
    // "Metas" tab, already mounted on every signed-in screen, never a second
    // link this module adds.
    await page.goto(`/metas/${goalId}`);
    await page.getByRole("navigation").getByRole("link", { name: "Metas", exact: true }).click();
    await page.waitForURL("**/metas");
    await expect(page.getByRole("link", { name: goalName })).toBeVisible();
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("an empty week says what to do and links to opening one (RP-11, RP-16)", async ({
  person,
  browser,
}) => {

  const context = await browser.newContext({
    storageState: person.sessionFile,
  });
  try {
    const page = await context.newPage();
    await page.goto("/semana");

    // The range still draws (`Semana.dc.html` names no board for a goal-
    // less week, so nothing here says the range itself should hide).
    await expect(page.getByText(/^Del \d/)).toBeVisible();
    await expect(page.getByText("Todavía no tienes una meta abierta.")).toBeVisible();
    const link = page.getByRole("link", { name: "Crear una meta" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/metas/nueva");
  } finally {
    await context.close();
  }
});
