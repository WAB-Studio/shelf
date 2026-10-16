import type { Browser, Locator, Page } from "@playwright/test";

import { civilDateToDate, civilDayMonthYear, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit, type Person } from "./fixtures";
import type { Db } from "./meta-arbol-seed";
import { MINUTES, dialog, horizonOfGoal, postCounter, seedOpenGoal } from "./metas-sin-final-seed";

// Module 964, RP-114 and the live end sheet (board FinalFaseEnVivo, approved 2026-10-14): while the end is chosen,
// a number that leaves the end before the last phase says the phase's refusal at once, disables «Moverlo» and moves the
// total to the thin line; correcting the number takes it all back. An end left untouched says the stored day, never the
// week edge the count would write (h6 of the train-s5 mutator). Dates are plain Monday arithmetic here, never the app's
// week helpers; the spec follows PULSAR_CLOCK. Every test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const DAY_MS = 86_400_000;
const WEEKS_LABEL = "semanas, contando esta";
const MONDAY = weekOf(todayInZone())[0];

function plusDays(day: string, days: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const fromThis = (n: number) => plusDays(MONDAY, 7 * n);
const lastDay = (n: number) => civilDayMonthYear(plusDays(fromThis(n), -1));
const weeks = (n: number) => `${n} ${n === 1 ? "semana" : "semanas"}`;
const OPENED = plusDays(MONDAY, -7);
// Weeks the goal has lived, this one included: 2.
const LIVED = Math.round((civilDateToDate(MONDAY).getTime() - civilDateToDate(OPENED).getTime()) / DAY_MS / 7) + 1;
const hintOf = (n: number) => `termina el ${lastDay(n)} · ${weeks(LIVED + n - 1)} en total`;
const line = (shown?: number) =>
  `contando desde esta semana; la meta lleva ${weeks(LIVED)}${shown === undefined ? "" : ` · ${weeks(shown)} en total`}`;
const INVALID = "Escribe un número entero de semanas, entre 1 y 520.";
const BASE_REFUSAL = "La fase «Base» llega hasta la semana 6 (7 desde la apertura). El final no puede quedar antes.";

async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width = 360, clock = false) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  await visit(page, path);
  return { page, context };
}

async function openMove(page: Page) {
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Cuántas semanas?" })).toBeVisible();
  return sheet;
}
const field = (sheet: Locator) => sheet.getByLabel(WEEKS_LABEL, { exact: true });
const button = (sheet: Locator, name: string) => sheet.getByRole("button", { name, exact: true });

// F1: «Correr 10 km», opened last Monday (it has lived 2 weeks), ending 10 weeks from this one; phase «Base» ends on
// the Sunday of week 6 from this one, the 7th from the opening.
async function seedF1(db: Db, person: Person, phaseEndsWeek = 6) {
  const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: MINUTES, horizon: fromThis(10), created: at(OPENED) });
  const [phase] = await db<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${id}, 'Base', ${OPENED}, ${plusDays(fromThis(phaseEndsWeek), -1)})
    returning id`;
  return { id, phase: phase.id };
}

test("F1 opens on 10 with the total in the hint and «Moverlo» ready (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: a refusal judged on the opening number, or a disabled «Moverlo» with nothing typed.
  const { id } = await seedF1(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    await expect(field(sheet)).toHaveValue("10");
    await expect(sheet.getByText(hintOf(10), { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(), { exact: true })).toBeVisible();
    await expect(button(sheet, "Moverlo")).toBeEnabled();
    await expect(field(sheet)).not.toHaveAttribute("aria-invalid", "true");
  } finally {
    await context.close();
  }
});

test("F1: writing 5, with nothing pressed, says the phase's refusal, marks the field, moves the total to the line and disables «Moverlo» (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: judging the phase only in `commit` (the pre-s7 sheet: the hint says «termina el … · 6 semanas en total»
  // until the button is pressed, and «Moverlo» stays enabled).
  const { id } = await seedF1(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await field(sheet).fill("5");
    const refusal = sheet.getByText(BASE_REFUSAL, { exact: true });
    await expect(refusal).toBeVisible();
    await expect(refusal).not.toContainText("en total");
    await expect(field(sheet)).toHaveAttribute("aria-invalid", "true");
    await expect(sheet.getByText(line(6), { exact: true })).toBeVisible();
    await expect(sheet.getByText(/^termina el /)).toHaveCount(0);
    await expect(button(sheet, "Moverlo")).toBeDisabled();
    await expect(button(sheet, "Quitar el final")).toBeEnabled();
    await expect(button(sheet, "Dejarlo como está")).toBeEnabled();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(10));
  } finally {
    await context.close();
  }
});

test("F1: from 5 to 6 the refusal goes, the hint says 7 semanas en total, «Moverlo» is ready, and pressing it moves the end; 10 → 5 → 10 comes back whole (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: leaving the refusal stuck once it has shown (state set on the first bad number and never cleared);
  // keeping «Moverlo» disabled after the correction.
  const { id } = await seedF1(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    await field(sheet).fill("5");
    await expect(button(sheet, "Moverlo")).toBeDisabled();
    await field(sheet).fill("10");
    await expect(sheet.getByText(hintOf(10), { exact: true })).toBeVisible();
    await expect(sheet.getByText(BASE_REFUSAL, { exact: true })).toHaveCount(0);
    await expect(button(sheet, "Moverlo")).toBeEnabled();
    await field(sheet).fill("5");
    await expect(button(sheet, "Moverlo")).toBeDisabled();
    await field(sheet).fill("6");
    await expect(sheet.getByText(hintOf(6), { exact: true })).toBeVisible();
    await expect(sheet.getByText(BASE_REFUSAL, { exact: true })).toHaveCount(0);
    await expect(sheet.getByText(line(), { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(6), { exact: true })).toHaveCount(0);
    await expect(field(sheet)).not.toHaveAttribute("aria-invalid", "true");
    await expect(button(sheet, "Moverlo")).toBeEnabled();
    await button(sheet, "Moverlo").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(6));
    await expect(page.getByText(new RegExp(`^${weeks(LIVED + 5)} · hasta el ${lastDay(6)}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F1: a 0, an empty field and a 521 say the number is not valid and never the phase's refusal (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: judging the phase on a number the schema rejects (0 is «before» every phase end, so a refusal would show).
  const { id } = await seedF1(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    for (const typed of ["0", "", "521"]) {
      await field(sheet).fill(typed);
      await expect(sheet.getByText(INVALID, { exact: true })).toBeVisible();
      await expect(sheet.getByText(/La fase «Base»/)).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

test("F1: a phase the page did not have is refused by the server after pressing, in the same words, and the end stays (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: swallowing the server's refusal (the sheet closes or stays silent) once the client judges first.
  const { id, phase } = await seedF1(db, person, 2);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    await field(sheet).fill("5");
    await expect(button(sheet, "Moverlo")).toBeEnabled();
    await expect(sheet.getByText(/La fase «Base»/)).toHaveCount(0);
    await db`update goals.phases set ends_on = ${plusDays(fromThis(6), -1)} where id = ${phase}`;
    await button(sheet, "Moverlo").click();
    await expect(sheet.getByText(BASE_REFUSAL, { exact: true })).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    expect(await horizonOfGoal(db, id)).toBe(fromThis(10));
  } finally {
    await context.close();
  }
});

test("F1: «Dejarlo como está» with 5 typed closes the sheet, sends nothing and the end stays (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: sending the refused number when the sheet is dismissed.
  const { id } = await seedF1(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 360, true);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await field(sheet).fill("5");
    await expect(button(sheet, "Moverlo")).toBeDisabled();
    await button(sheet, "Dejarlo como está").click();
    await expect(dialog(page)).toHaveCount(0);
    await page.clock.runFor(30_000);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(10));
  } finally {
    await context.close();
  }
});

test("a goal with no phase accepts 5: no refusal, «Moverlo» ready, and the end moves (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: refusing a short end when the goal has no phase (a phase end defaulting to the opening or to 0).
  const id = await seedOpenGoal(db, person, { name: "Sin fase", unit: MINUTES, horizon: fromThis(10), created: at(OPENED) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    await field(sheet).fill("5");
    await expect(sheet.getByText(hintOf(5), { exact: true })).toBeVisible();
    await expect(sheet.getByText(/La fase/)).toHaveCount(0);
    await expect(button(sheet, "Moverlo")).toBeEnabled();
    await button(sheet, "Moverlo").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(5));
  } finally {
    await context.close();
  }
});

test("F2 (h6): an end stored off the week edge, left untouched, says its stored last day and its own total, never the Sunday the count would write (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: `untouched && storedHorizon` → `false` (the hint then names the Sunday after, one week of total more).
  // The end is stored a Wednesday: its last day is the Tuesday, inside the 9th week counted from this one.
  const stored = plusDays(fromThis(8), 2);
  const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: MINUTES, horizon: stored, created: at(OPENED) });
  const lastStored = civilDayMonthYear(plusDays(stored, -1));
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    await expect(field(sheet)).toHaveValue("9");
    await expect(sheet.getByText(`termina el ${lastStored} · ${weeks(LIVED + 8)} en total`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(`termina el ${lastDay(9)} · ${weeks(LIVED + 9)} en total`, { exact: true })).toHaveCount(0);
    // Typing the same number again is still «untouched»; typing another one writes the Monday count.
    await field(sheet).fill("10");
    await expect(sheet.getByText(hintOf(10), { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("at 360 the sheet with the live refusal and the line's total does not overflow the screen (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: a refusal or a line wider than the sheet (a text drawn outside `components/ui`), with nothing pressed.
  const { id } = await seedF1(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 360);
  try {
    const sheet = await openMove(page);
    await field(sheet).fill("5");
    await expect(sheet.getByText(BASE_REFUSAL, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(6), { exact: true })).toBeVisible();
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
