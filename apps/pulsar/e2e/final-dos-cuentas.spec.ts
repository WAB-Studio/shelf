import type { Browser, Locator, Page } from "@playwright/test";

import { civilDateToDate, civilDayMonthYear, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit, type Person } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import type { Db } from "./meta-arbol-seed";
import { MINUTES, dialog, horizonOfGoal, postCounter, seedOpenGoal } from "./metas-sin-final-seed";

// Module 938, RP-111: the end sheet says both counts under its field, «contando desde esta semana; la meta lleva N
// semanas» (this week counts too), and a phase refusal names its week in both. Board FinalDosCuentas
// (private/tableros-s4/NOTAS.md §2); the user's decision of 2026-10-13: «Correr 10 km» lleva 2, «Leer» lleva 102.
// Every date is plain day arithmetic from today's Monday, never the app's own week helpers; the spec follows
// PULSAR_CLOCK. Every test names the mutation that kills it.

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
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Weeks the goal has lived, this one included: the Monday of its opening is week 1.
const lives = (opened: string) =>
  Math.round((civilDateToDate(MONDAY).getTime() - civilDateToDate(weekOf(opened)[0]).getTime()) / DAY_MS / 7) + 1;
const line = (n: number) => `contando desde esta semana; la meta lleva ${n} ${n === 1 ? "semana" : "semanas"}`;

const OPENED_LONG_AGO = "2024-11-05";
const OPENED_LAST_MONDAY = plusDays(MONDAY, -7);

async function open(browser: Browser, baseURL: string | undefined, sessionFile: string, path: string, width = 360) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

async function openSheet(page: Page, button: "mover el final" | "ponerle final") {
  await page.getByRole("button", { name: button }).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Cuántas semanas?" })).toBeVisible();
  return sheet;
}
const field = (sheet: Locator) => sheet.getByLabel(WEEKS_LABEL, { exact: true });

// E2: opened last Monday, ends 8 weeks from this one, inside «Salud»; phase «Preparación» ends on the Sunday of week 6.
async function seedE2(db: Db, person: Person, opts: { phaseEndsWeek?: number } = {}) {
  const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: fromThis(40), created: at("2024-04-10") });
  const correr = await seedOpenGoal(db, person, {
    name: "Correr 10 km",
    parent: salud,
    unit: MINUTES,
    horizon: fromThis(8),
    created: at(OPENED_LAST_MONDAY),
  });
  const [phase] = await db<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${correr}, 'Preparación', ${OPENED_LAST_MONDAY}, ${plusDays(fromThis(opts.phaseEndsWeek ?? 6), -1)})
    returning id`;
  return { correr, phase: phase.id };
}

test("E2: «mover el final» draws «contando desde esta semana; la meta lleva 2 semanas» under the field, outside the hint (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: `n = weekIndexOf(openedOn, today) - 1` (says 1); the line drawn inside the `hint` (the hint's own element carries it).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    await expect(field(sheet)).toHaveValue("8");
    const hint = sheet.getByText(`termina el ${lastDay(8)}`, { exact: true });
    await expect(hint).toBeVisible();
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    await expect(hint).not.toContainText("lleva");
    // Under the field, not above it.
    const box = async (l: Locator) => (await l.boundingBox())!;
    expect((await box(sheet.getByText(line(2), { exact: true }))).y).toBeGreaterThan((await box(field(sheet))).y);
  } finally {
    await context.close();
  }
});

test("a goal opened this week says «la meta lleva 1 semana», in the singular (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: a fixed plural («1 semanas»); `n` counted as weeks elapsed (0).
  const id = await seedOpenGoal(db, person, { name: "Recién", unit: MINUTES, horizon: fromThis(5), created: at(MONDAY) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    await expect(sheet.getByText(line(1), { exact: true })).toBeVisible();
    await expect(sheet.getByText(/lleva 1 semanas/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("E2b: «Leer», no end, opened 5 nov 2024: «ponerle final» says the weeks it has lived; 12 writes the Monday after week 12 from today and the screen reads n + 11 (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: `n` counted from today (says 1); counted to last week (one short); the screen anchored on this week.
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: at(OPENED_LONG_AGO) });
  const n = lives(OPENED_LONG_AGO);
  expect(n).toBeGreaterThanOrEqual(102);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "ponerle final");
    await expect(field(sheet)).toHaveValue("12");
    await expect(sheet.getByText(`termina el ${lastDay(12)}`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(n), { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Ponerle final", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(12));
    await expect(page.getByText(new RegExp(`^${n + 11} semanas · hasta el ${escape(lastDay(12))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2b: «Pintar la sala», ended, reopens at 1280 on 1, ending this Sunday, with «lleva 8 semanas» (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: not drawing the line when reopening (`reopening ? null : line`); counting to the end date instead of today.
  const opened = plusDays(MONDAY, -49);
  const id = await seedOpenGoal(db, person, { name: "Pintar la sala", unit: MINUTES, horizon: MONDAY, created: at(opened) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 1280);
  try {
    const sheet = await openSheet(page, "mover el final");
    await expect(field(sheet)).toHaveValue("1");
    await expect(sheet.getByText(`termina el ${lastDay(1)}`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(8), { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: 4 weeks is refused naming the phase's week in both counts, nothing is written, and the line stays in view (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: `weekIndexOf(today, …)` for both numbers (says «6 (6 …»); the sentence without `fromOpening`; the line inside the `hint`
  // (the refusal would cover it).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("4");
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    if (await move.isEnabled()) await move.click();
    const refusal = sheet.getByText("La fase «Preparación» llega hasta la semana 6 (7 desde la apertura). El final no puede quedar antes.", { exact: true });
    await expect(refusal).toBeVisible();
    await expect(field(sheet)).toHaveAttribute("aria-invalid", "true");
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    await expect(refusal).not.toContainText("contando desde");
    await expect(dialog(page)).toBeVisible();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
  } finally {
    await context.close();
  }
});

test("a phase lengthened between load and send: the server's refusal carries the same two counts and the line (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: the server's refusal rendered without `fromOpening` (the sentence ends «semana N. El final…»).
  const { correr, phase } = await seedE2(db, person, { phaseEndsWeek: 2 });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("5");
    // The sheet loaded with a phase ending in week 2: 5 passes here. Now the phase grows past it.
    await db`update goals.phases set ends_on = ${plusDays(fromThis(7), -1)} where id = ${phase}`;
    await sheet.getByRole("button", { name: "Moverlo", exact: true }).click();
    // The phase now ends the Sunday of week 7 from this one: 8 from the opening, a week ahead of the page's own.
    const refusal = sheet.getByText("La fase «Preparación» llega hasta la semana 7 (8 desde la apertura). El final no puede quedar antes.", { exact: true });
    await expect(refusal).toBeVisible();
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
  } finally {
    await context.close();
  }
});

test("E2: a 0 says the number is not valid and the line stays (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: hiding the line while the field is invalid.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("0");
    await expect(sheet.getByText("Escribe un número entero de semanas, entre 1 y 520.", { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: with the action held, the buttons are disabled, a second tap sends nothing more, and the line stays (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: not disabling the sheet's buttons while the action is in flight; dropping the line while pending.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("10");
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    await holdActions(page, 1500);
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await move.click();
    await expect(move).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Quitar el final", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Dejarlo como está", exact: true })).toBeDisabled();
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    await move.dispatchEvent("click");
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(10));
  } finally {
    await context.close();
  }
});

test("E2: «Dejarlo como está» after typing 10 closes the sheet and sends nothing (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: sending the typed number when the sheet is dismissed.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("10");
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Dejarlo como está", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
  } finally {
    await context.close();
  }
});

test("at 360 the sheet with the line and the phase refusal does not overflow the screen (RP-111)", async ({ person, browser, baseURL, db }) => {
  // Kills: the line or the longer refusal wider than the sheet (a text drawn outside `components/ui`).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`, 360);
  try {
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("4");
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    if (await move.isEnabled()) await move.click();
    await expect(sheet.getByText(/^La fase «Preparación» llega hasta la semana 6 \(7 desde la apertura\)/)).toBeVisible();
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
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
