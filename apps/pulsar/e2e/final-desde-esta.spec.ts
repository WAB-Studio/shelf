import type { Browser, Page } from "@playwright/test";

import { civilDateToDate, civilDayMonthYear, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import { MINUTES, dialog, horizonOfGoal, postCounter, seedOpenGoal } from "./metas-sin-final-seed";

// Module 925, RP-103: putting an end on a goal with no end counts its weeks from the current week, never from the day
// the goal opened. Boards: PonerFinalDesdeEsta (private/tableros-s2/NOTAS.md §3). The words are the user's of 2026-10-13.
// Every date below is derived from today's Monday by plain day arithmetic, never from the app's own week helpers.
// Every test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const WEEKS_LABEL = "semanas, contando esta";
const OPENED_LONG_AGO = new Date("2024-04-10T12:00:00Z");

function plusDays(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// The Monday after week `n` counting the current one as week 1: the horizon the person's `n` stands for.
const horizonFromThisWeek = (n: number) => plusDays(weekOf(todayInZone())[0], 7 * n);
// The Sunday of that week, as the sheet writes it.
const endWords = (n: number) => civilDayMonthYear(plusDays(horizonFromThisWeek(n), -1));

async function openPutSheet(page: Page) {
  await page.getByRole("button", { name: "ponerle final" }).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Cuántas semanas?" })).toBeVisible();
  return sheet;
}

async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width = 360) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

test("a goal with no end, opened long ago, offers 12 weeks counted from this one and writes the Monday after week 12 from today (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: `horizonForWeeks(openedOn, n)` kept for a goal with no end (the sheet counts from the 2024 opening, the label
  // stays «contando la del …», the stored horizon lands in 2024).
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openPutSheet(page);
    const field = sheet.getByLabel(WEEKS_LABEL, { exact: true });
    await expect(field).toHaveValue("12");
    await expect(sheet.getByText(`termina el ${endWords(12)}`, { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Ponerle final", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(horizonFromThisWeek(12));
    // The done state: the notice with the date, and the end can be moved.
    await expect(page.getByText(`Leer termina el ${endWords(12)}.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "mover el final" })).toBeVisible();
    await expect(page.getByRole("button", { name: "ponerle final" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the hint follows the weeks typed and carries the year (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping the year from the hint; the hint counting from the opening or from the typed value's previous state.
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openPutSheet(page);
    await sheet.getByLabel(WEEKS_LABEL, { exact: true }).fill("60");
    const expected = endWords(60);
    expect(expected).toMatch(/ \d{4}$/);
    await expect(sheet.getByText(`termina el ${expected}`, { exact: true })).toBeVisible();
    await sheet.getByLabel(WEEKS_LABEL, { exact: true }).fill("1");
    await expect(sheet.getByText(`termina el ${endWords(1)}`, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("«Ponerle final» pends disabled, with «Dejarla sin final» disabled too, then the end lands (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: a put button with no pending state (a second tap writes twice).
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openPutSheet(page);
    await expect(sheet.getByLabel(WEEKS_LABEL, { exact: true })).toBeVisible();
    await holdActions(page, 1500);
    await sheet.getByRole("button", { name: "Ponerle final", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "Ponerle final", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Dejarla sin final", exact: true })).toBeDisabled();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(horizonFromThisWeek(12));
  } finally {
    await context.close();
  }
});

test("a phase ending in week 20 from today refuses 12, names week 20 counted from this week, and writes nothing (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: counting the phase's week from the opening (the sentence would name week ~110); writing despite the phase.
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  const phase = `Primer lector ${Date.now()}`;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${id}, ${phase}, ${weekOf(todayInZone())[0]}, ${plusDays(horizonFromThisWeek(20), -1)})`;
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openPutSheet(page);
    const field = sheet.getByLabel(WEEKS_LABEL, { exact: true });
    await field.fill("12");
    const put = sheet.getByRole("button", { name: "Ponerle final", exact: true });
    // The refusal may stand as the weeks are typed (button disabled) or after the tap: both end on the sentence.
    if (await put.isEnabled()) await put.click();
    await expect(
      sheet.getByText(`La fase «${phase}» llega hasta la semana 20. El final no puede quedar antes.`, { exact: true }),
    ).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(dialog(page)).toBeVisible();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, id)).toBeNull();
    // 20 is exactly the phase's last week: not a refusal.
    await field.fill("20");
    await expect(sheet.getByRole("button", { name: "Ponerle final", exact: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("a goal holding another with no end refuses the put naming it, and nothing is written (RP-103, RP-99)", async ({ person, browser, baseURL, db }) => {
  // Kills: the new count path skipping the tree rule; a generic sentence in place of `tree.errors.belowNoEnd`.
  const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  await seedOpenGoal(db, person, { name: "Dormir mejor", parent: salud, unit: MINUTES, horizon: null });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${salud}`);
  try {
    const posts = postCounter(page);
    const sheet = await openPutSheet(page);
    await sheet.getByLabel(WEEKS_LABEL, { exact: true }).fill("12");
    await expect(sheet.getByText("“Dormir mejor” no tiene final: dale uno antes.", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Ponerle final", exact: true })).toBeDisabled();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, salud)).toBeNull();
  } finally {
    await context.close();
  }
});

test("«Dejarla sin final» closes the sheet, sends nothing and the goal keeps no end (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: «Dejarla sin final» wired to the put; closing after writing.
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openPutSheet(page);
    await sheet.getByLabel(WEEKS_LABEL, { exact: true }).fill("5");
    await sheet.getByRole("button", { name: "Dejarla sin final", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, id)).toBeNull();
    await expect(page.getByRole("button", { name: "ponerle final" })).toBeVisible();
    await expect(page.getByRole("button", { name: "mover el final" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("control: a goal with an end keeps «contando la del {fecha}» and moves it counting from its opening (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: the from-this-week count leaking into a goal that has an end (its label loses «la del», its move lands weeks off).
  const openedAt = new Date(Date.now() - 21 * 86_400_000);
  const openedMonday = weekOf(dateToCivilDate(openedAt))[0];
  const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: MINUTES, horizon: plusDays(openedMonday, 7 * 9), created: openedAt });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: "mover el final" }).click();
    const sheet = dialog(page);
    const field = sheet.getByLabel(/^semanas, contando la del \d{1,2} de /);
    await expect(field).toHaveValue("9");
    await expect(sheet.getByLabel(WEEKS_LABEL, { exact: true })).toHaveCount(0);
    await field.fill("14");
    await sheet.getByRole("button", { name: "Moverlo", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(plusDays(openedMonday, 7 * 14));
  } finally {
    await context.close();
  }
});

test("at 360 the sheet and its hint do not overflow the screen (RP-103)", async ({ person, browser, baseURL, db }) => {
  // Kills: a hint or a field wider than the sheet (a fixed width or a no-wrap line).
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: OPENED_LONG_AGO });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 360);
  try {
    const sheet = await openPutSheet(page);
    await sheet.getByLabel(WEEKS_LABEL, { exact: true }).fill("520");
    await expect(sheet.getByText(/^termina el /)).toBeVisible();
    const over = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
      const box = dlg.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sheet: dlg.scrollWidth - dlg.clientWidth,
        right: box.right - window.innerWidth,
        left: box.left,
      };
    });
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.sheet).toBeLessThanOrEqual(0);
    expect(over.right).toBeLessThanOrEqual(0);
    expect(over.left).toBeGreaterThanOrEqual(0);
  } finally {
    await context.close();
  }
});
