import type { Page } from "@playwright/test";

import { todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";
import plan from "../messages/es/plan.json";

async function createGoal(page: Page, name: string, horizonWeeks: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByLabel("final").fill(horizonWeeks);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

// RP-15: the weeks the form offers are weeks its own checks accept.
test("the default span submits and lands; with no week left the fields open empty", async ({
  person,
  browser,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    const goalId = await createGoal(page, `Meta fase defecto ${Date.now()}`, "2");

    await page.goto(`/metas/${goalId}/fases/nueva`);
    await expect(page.getByLabel("desde la semana")).toHaveValue("1");
    await expect(page.getByLabel("hasta la semana")).toHaveValue("2");
    await page.getByLabel(plan.phaseForm.aimLabel).fill(`Defecto ${Date.now()}`);
    await page.getByRole("button", { name: plan.phaseForm.submit }).click();
    await page.waitForURL(`**/metas/${goalId}`);
    await expect(page.getByText("semanas 1–2")).toBeVisible();

    // The horizon is spent: nothing to offer, so nothing is prefilled.
    await page.goto(`/metas/${goalId}/fases/nueva`);
    await expect(page.getByLabel("desde la semana")).toHaveValue("");
    await expect(page.getByLabel("hasta la semana")).toHaveValue("");
  } finally {
    await context.close();
  }
});

// RP-15: the goal's partial last week is a week the form offers, and its phase
// ends on the goal's last day.
test("a goal ending mid-week offers its partial last week as the default and lands it", async ({
  person,
  browser,
  db,
}) => {
  const monday = weekOf(todayInZone())[0];
  const ends = new Date(`${monday}T12:00:00Z`);
  ends.setUTCDate(ends.getUTCDate() + 14 + 3); // Thursday of week 3: the horizon is its Friday
  const horizon = ends.toISOString().slice(0, 10);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, ${`Meta semana parcial ${Date.now()}`}, ${horizon}::date) returning id
  `;
  const context = await browser.newContext({ storageState: person.sessionFile });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}/fases/nueva`);
    await expect(page.getByLabel("desde la semana")).toHaveValue("1");
    await expect(page.getByLabel("hasta la semana")).toHaveValue("3");
    await page.getByLabel(plan.phaseForm.aimLabel).fill(`Parcial ${Date.now()}`);
    await page.getByRole("button", { name: plan.phaseForm.submit }).click();
    await page.waitForURL(`**/metas/${goal.id}`);
    await expect(page.getByText("semanas 1–3")).toBeVisible();

    await page.goto(`/metas/${goal.id}/fases/nueva`);
    await expect(page.getByLabel("desde la semana")).toHaveValue("");
  } finally {
    await context.close();
  }
});
