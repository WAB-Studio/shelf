import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { weekSpan } from "@/lib/day/weeks";
import { civilDateInZone, civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, laneNumber } from "./fixtures";
import { boxOf } from "./box";

// The civil day `days` after `openedOn`, in the same midday-UTC arithmetic
// `weekSpan` itself runs (`lib/day/weeks.ts`) — never a second, independent
// calculation of what a week's own start day is.
function dayAfter(openedOn: string, days: number): string {
  const date = civilDateToDate(openedOn);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// The Wednesday of the week two Mondays back: `today` always sits in week 3
// (RP-17), whatever weekday the spec runs on, and week 1 is partial. Every
// week's own start comes from `weekSpan`, never a fixed count of days.
const OPENED_WEEKDAY_OFFSET = 2;
// In minutes: 690 and 60 sum to the 750 the goal reads as «12 h 30 min»
// (RP-35), and each week reads in hours and minutes of its own.
const WEEK1_TOTAL = 690;
const WEEK2_TOTAL = 60;
// Week 3 (today's own) gets no fact at all: the zero `measureByWeek` must
// still draw, on the same row `current` marks.

async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

// The goal's own way in (docs/goallog/DESIGN.md "A goal adds a commitment
// from its own screen"): a real tap on the list's own link, never a bare
// `page.goto` to the form's route.
async function addQuantityCommitment(
  page: Page,
  goalId: string,
  name: string,
  unit: string,
  target: number,
): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);

  await page.getByLabel("qué es").fill(name);
  await page.getByRole("button", { name: "un número", exact: true }).click();
  await page.getByLabel("cantidad", { exact: true }).fill(String(target));
  await page.getByLabel("unidad").fill(unit);
  await page.getByRole("button", { name: "Añadirlo" }).click();
  await page.waitForURL(`**/metas/${goalId}`);
}

async function commitmentId(db: postgres.Sql, personId: string, name: string): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    select id from goals.commitments where user_id = ${personId} and name = ${name}
  `;
  if (!row) throw new Error(`no commitment named "${name}" for ${personId}`);
  return row.id;
}

async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

test("a goal opened on a Wednesday two weeks back draws its measure week by week in hours and minutes, the current week's zero included (RP-17, RP-35)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const goalName = `Meta revisión ${lane} ${Date.now()}`;
  const measureName = `Medida revisión ${lane} ${Date.now()}`;
  const unit = "minutos";
  const goalId = await createGoal(page, goalName);

  try {
    await addQuantityCommitment(page, goalId, measureName, unit, 5);

    // The way in (`Meta.dc.html` draws none, the coordinator's own decision):
    // a text link (the one accent link style) under the measure figure, only once the goal has one.
    await page.goto(`/metas/${goalId}`);
    const wayIn = page.getByRole("link", { name: "Ver por semana" });
    await expect(wayIn).toBeVisible();
    await expect(wayIn).toHaveAttribute("data-part", "text-link");
    await expect(wayIn).toHaveAttribute("href", `/metas/${goalId}/revision`);

    const id = await commitmentId(db, personId, measureName);

    // `created_at` carries no grant to `authenticated` at all
    // (`db/schema/goals.ts`): the session pooler is the only door onto it,
    // the same one `scripts/check-goal.ts`'s own `runWeeksCheck` uses.
    const openedOn = dayAfter(weekOf(todayInZone())[0], -14 + OPENED_WEEKDAY_OFFSET);
    const openedDaysBack =
      (civilDateToDate(todayInZone()).getTime() - civilDateToDate(openedOn).getTime()) / 86_400_000;
    const backdatedAt = new Date(Date.now() - openedDaysBack * 86_400_000);
    await db`update goals.goals set created_at = ${backdatedAt} where id = ${goalId} and user_id = ${personId}`;
    expect(civilDateInZone(backdatedAt)).toBe(openedOn);

    await db`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
      values (${personId}, ${goalId}, 'Fase única', ${openedOn}, ${dayAfter(openedOn, 20)})
    `;

    // Facts in two of the three weeks (week 1's own opening day, week 2's
    // own opening day); week 3, today's own, gets none.
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values
        (${personId}, ${id}, ${goalId}, ${openedOn}, ${WEEK1_TOTAL}),
        (${personId}, ${id}, ${goalId}, ${weekSpan(openedOn, 2, 2).startsOn}, ${WEEK2_TOTAL})
    `;

    // The goal's own figure: 750 minutes in hours and minutes, and no
    // «minutos» after them; its measure line reads «mide en horas y minutos».
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("mide en horas y minutos", { exact: true })).toBeVisible();
    await expect(page.getByText(`mide en ${unit}`, { exact: true })).toHaveCount(0);
    // The total comes first; the month block under it may repeat it (RP-28).
    await expect(page.getByText("12 h 30 min", { exact: true }).first()).toBeVisible();

    await page.goto(`/metas/${goalId}/revision`);

    // `RevisionAncha.dc.html`: one `h1` in the header, the way back named for
    // the goal, the measure's unit on its mono line.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Por semana");
    const measureLine = page.getByText("mide en horas y minutos", { exact: true });
    await expect(measureLine).toBeVisible();
    await expect(page.getByText(`mide en ${unit}`, { exact: true })).toHaveCount(0);
    // A sentence is Archivo, never mono (`SistemaTipo`).
    expect.soft(await measureLine.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
    await expect(page.getByLabel(`Volver a ${goalName}`)).toHaveAttribute("href", `/metas/${goalId}`);
    await expect(page.getByRole("link", { name: "Volver a la meta" })).toHaveCount(0);
    await expect(page.getByText("la única cifra que predice el progreso")).toHaveCount(0);

    // The phone face, `Revision.dc.html`: three rows, the lead figure and
    // the note alone, «0» drawn rather than hidden, «en curso» on the one
    // row with nothing.
    const items = page.getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText("semana 1");
    await expect(items.nth(0)).toContainText("11 h 30 min");
    await expect(items.nth(1)).toContainText("semana 2");
    await expect(items.nth(1)).toContainText("1 h");
    await expect(items.nth(2)).toContainText("semana 3");
    await expect(items.nth(2)).toContainText("0 min");
    // The unit word no longer follows each figure (`RevisionHoras.dc.html`).
    await expect(items.filter({ hasText: unit })).toHaveCount(0);
    await expect(items.nth(2)).toContainText("en curso");
    await expect(items.nth(0)).not.toContainText("en curso");
    await expect(items.nth(1)).not.toContainText("en curso");
    await expect(page.locator("li[data-current]")).toHaveCount(1);
    await expect(items.nth(2)).toHaveAttribute("data-current", "");

    // RNP-07: nothing overflows the 360px viewport this project already runs.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(360);

    // `RevisionEscritorio.dc.html`: the same rows, a real `<table>`, widened
    // past the kit's usual 640px cap.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByText("mide en horas y minutos", { exact: true })).toBeVisible();
    await expect(page.getByText(`mide en ${unit}`, { exact: true })).toHaveCount(0);
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    const rows = table.getByRole("row");
    await expect(rows).toHaveCount(4); // the header row plus three weeks

    const week1Row = rows.nth(1);
    await expect(week1Row.getByRole("cell").nth(0)).toContainText("semana 1");
    await expect(week1Row.getByRole("cell").nth(1)).toHaveText("11 h 30 min");
    await expect(week1Row).not.toHaveAttribute("data-current", "");

    const week3Row = rows.nth(3);
    await expect(week3Row.getByRole("cell").nth(0)).toContainText("semana 3");
    await expect(week3Row.getByRole("cell").nth(1)).toHaveText("0 min");
    // «en curso» is a mark after the week's dates, not a cell: SEMANA, TOTAL and FASE are the columns.
    await expect(week3Row.getByRole("cell")).toHaveCount(3);
    await expect(week3Row.getByRole("cell").nth(0)).toContainText("en curso");
    await expect(week3Row).toHaveAttribute("data-current", "");

    // A phase is named on the week it starts, not again on each week it spans.
    await expect.soft(week1Row.getByRole("cell").nth(2)).toHaveText("Fase única");
    await expect.soft(rows.nth(2).getByRole("cell").nth(2)).toHaveText("");
    await expect.soft(week3Row.getByRole("cell").nth(2)).toHaveText("");

    // From 1024 the table spans the main column, past the old 1020 cap.
    const tableWidth = (await boxOf(table)).width;
    expect(tableWidth).toBeGreaterThan(1020);
    const mainWidth = await page.evaluate(() => document.querySelector("main")?.getBoundingClientRect().width);
    expect(tableWidth).toBeGreaterThan(mainWidth! * 0.8);

    // The header's way back is the only one: no link after the table.
    await expect(page.getByRole("link", { name: "Volver a la meta" })).toHaveCount(0);
    await page.getByLabel(`Volver a ${goalName}`).click();
    await page.waitForURL(`**/metas/${goalId}`);

    for (const width of [360, 390, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goalId}/revision`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a goal with no measure yet says so on its review, with no way in and no table (RP-17, §0.3 3)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const goalName = `Meta revisión sin medida ${lane} ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByRole("link", { name: "Ver por semana" })).toHaveCount(0);

    await page.goto(`/metas/${goalId}/revision`);
    await expect(page.getByText("Esta meta todavía no tiene cifra.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("listitem")).toHaveCount(0);

    await expect(page.getByRole("link", { name: "Añadir un compromiso" })).toHaveCount(0);

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Volver a la meta" })).toHaveCount(0);
    await page.getByLabel(`Volver a ${goalName}`).click();
    await page.waitForURL(`**/metas/${goalId}`);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a goal id that resolves to nothing 404s the review, never a blank screen", async ({ page }) => {
  await page.goto("/metas/00000000-0000-0000-0000-000000000000/revision");
  await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
});

test("an id that is no uuid 404s the review on a live database, never the failure page", async ({ page }) => {
  await page.goto("/metas/not-a-uuid/revision");
  await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toHaveCount(0);
});

test("a goal measured in «páginas» reads its plain number on the goal and in the review, the unit beside it (RP-35)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const goalName = `Meta revisión páginas ${lane} ${Date.now()}`;
  const measureName = `Medida páginas ${lane} ${Date.now()}`;
  const unit = "páginas";
  const goalId = await createGoal(page, goalName);

  try {
    await addQuantityCommitment(page, goalId, measureName, unit, 5);
    const id = await commitmentId(db, personId, measureName);
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${personId}, ${id}, ${goalId}, ${todayInZone()}, 750)
    `;

    await page.goto(`/metas/${goalId}`);
    // The goal's total sits right above «en total, desde…»; the month block below carries its own 750.
    const total = page
      .locator("p", { hasText: /^en total, desde el / })
      .locator("visible=true")
      .locator("xpath=preceding-sibling::*[1]");
    await expect(total).toHaveCount(1);
    await expect(total).toHaveText(`750 ${unit}`);
    // The month block beside «sin monto planeado» names the unit too, as the total does.
    const monthFigure = page
      .getByText("sin monto planeado")
      .locator("visible=true")
      .locator("xpath=./*[1]");
    await expect(monthFigure).toHaveCount(1);
    await expect(monthFigure).toHaveJSProperty("textContent", `750\u00a0${unit}`);
    await expect(page.getByText(`mide en ${unit}`, { exact: true })).toBeVisible();
    await expect(page.getByText("mide en horas y minutos")).toHaveCount(0);

    await page.goto(`/metas/${goalId}/revision`);
    await expect(page.getByText(`mide en ${unit}`, { exact: true })).toBeVisible();
    await expect(page.getByText("mide en horas y minutos")).toHaveCount(0);
    await expect(page.locator("li[data-current]")).toContainText(`750${unit}`);

    await page.setViewportSize({ width: 1280, height: 900 });
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader").nth(1)).toHaveText(`total${unit}`);
    await expect(table.locator("tr[data-current]").getByRole("cell").nth(1)).toHaveText("750");
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});
