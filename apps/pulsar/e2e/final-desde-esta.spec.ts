import type { Browser, Locator, Page } from "@playwright/test";

import { civilDateToDate, civilDayMonthYear, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit, type Person } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import { MINUTES, dialog, horizonOfGoal, postCounter, seedOpenGoal } from "./metas-sin-final-seed";
import type { Db } from "./meta-arbol-seed";

// Module 925, RP-103: putting an end on a goal with no end counts its weeks from the current week, never from the day
// the goal opened. Boards: PonerFinalDesdeEsta (private/tableros-s2/NOTAS.md §3). The words are the user's of 2026-10-13.
// Every date below is derived from today's Monday by plain day arithmetic, never from the app's own week helpers.
// Every test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const WEEKS_LABEL = "semanas, contando esta";
const OPENED_LONG_AGO = new Date("2024-04-10T12:00:00Z");

// Whole Mondays between the goal's opening week and this one.
function weeksSinceOpening(opened: Date): number {
  const monday = (d: string) => civilDateToDate(weekOf(d)[0]).getTime();
  return Math.round((monday(todayInZone()) - monday(dateToCivilDate(opened))) / 86_400_000 / 7);
}

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
    await expect(sheet.getByText(new RegExp(`^termina el ${escape(endWords(12))} · \\d+ semanas? en total$`))).toBeVisible();
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
    await expect(sheet.getByText(new RegExp(`^termina el ${escape(expected)} · \\d+ semanas? en total$`))).toBeVisible();
    await sheet.getByLabel(WEEKS_LABEL, { exact: true }).fill("1");
    await expect(sheet.getByText(new RegExp(`^termina el ${escape(endWords(1))} · \\d+ semanas? en total$`))).toBeVisible();
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
      sheet.getByText(`La fase «${phase}» llega hasta la semana 20 (${20 + weeksSinceOpening(OPENED_LONG_AGO)} desde la apertura). El final no puede quedar antes.`, { exact: true }),
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

// ---------------------------------------------------------------------------------------------------------------------
// Module 931 (RP-108), board FinalSemanasContando (private/tableros-s3/NOTAS.md §3): every sheet counts «semanas,
// contando esta», a goal with an end included. The goal's own screen keeps counting from its opening. Example E2:
// «Correr 10 km» opened last Monday, its end 8 weeks from this week's Monday (9 from the opening), inside «Salud»,
// which ends in week 11; phase «Preparación» ends on the Sunday of week 6 from this week (week 7 from the opening).
// ---------------------------------------------------------------------------------------------------------------------

const MONDAY = weekOf(todayInZone())[0];
const OPENED_LAST_MONDAY = plusDays(MONDAY, -7);
// The stored horizon (the Monday after the last week) of an end `n` weeks counted from this one.
const fromThis = (n: number) => plusDays(MONDAY, 7 * n);
// The last day's words, «6 dic 2026».
const lastDay = (n: number) => civilDayMonthYear(plusDays(fromThis(n), -1));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function seedE2(db: Db, person: Person) {
  const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: fromThis(11), created: OPENED_LONG_AGO });
  const correr = await seedOpenGoal(db, person, {
    name: "Correr 10 km",
    parent: salud,
    unit: MINUTES,
    horizon: fromThis(8),
    created: new Date(`${OPENED_LAST_MONDAY}T12:00:00Z`),
  });
  // Starts on the opening Monday, ends on the Sunday of week 6 from this week.
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${correr}, 'Preparación', ${OPENED_LAST_MONDAY}, ${plusDays(fromThis(6), -1)})`;
  return { salud, correr };
}

async function openMove(page: Page) {
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = dialog(page);
  await expect(sheet.getByRole("heading", { name: "¿Cuántas semanas?" })).toBeVisible();
  return sheet;
}

const moveField = (sheet: Locator) => sheet.getByLabel(WEEKS_LABEL, { exact: true });

test("E2: «mover el final» opens on 8, labelled «semanas, contando esta», ending the Sunday the goal already ends (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: `weeks: totalWeeks` (the sheet opens on 9, counted from the opening, labelled «contando la del 5 oct»).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openMove(page);
    await expect(moveField(sheet)).toHaveValue("8");
    await expect(sheet.getByLabel(/contando la del/)).toHaveCount(0);
    await expect(sheet.getByText(new RegExp(`^termina el ${escape(lastDay(8))} · \\d+ semanas? en total$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: the goal's screen still counts from the opening: 9 weeks and the phase in weeks 1–7 (RP-108 control)", async ({ person, browser, baseURL, db }) => {
  // Kills: the screen's line or the phase span counted from this week (8 and «semanas 1–6»).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    await expect(page.getByText(new RegExp(`^9 semanas · hasta el ${escape(lastDay(8))}$`))).toBeVisible();
    await expect(page.locator("main").first()).toContainText(/semanas\s*1–7/);
    await expect(page.locator("main").first()).not.toContainText(/semanas\s*1–6/);
  } finally {
    await context.close();
  }
});

test("E2: leaving the 8 as it is and tapping «Moverlo» closes the sheet and sends nothing (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: removing `untouched` (the untouched 8 is sent and rewrites the horizon from this week, or the sheet stays open).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await expect(moveField(sheet)).toHaveValue("8");
    await sheet.getByRole("button", { name: "Moverlo", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
    await expect(page.getByText(new RegExp(`^9 semanas · hasta el ${escape(lastDay(8))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: writing 10 hints the end with its year, writes the Monday after week 10 from this week, and the screen reads 11 weeks (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: anchoring the sheet on the opening (the Monday lands a week early); `civilDateLabel` without the year in the hint.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openMove(page);
    await moveField(sheet).fill("10");
    const hint = sheet.getByText(/^termina el /);
    await expect(hint).toHaveText(new RegExp(`^termina el ${escape(lastDay(10))} · \\d+ semanas? en total$`));
    expect(lastDay(10)).toMatch(/ \d{4}$/);
    await sheet.getByRole("button", { name: "Moverlo", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(10));
    // Counted from the opening, a week earlier than this one: 11.
    await expect(page.getByText(new RegExp(`^11 semanas · hasta el ${escape(lastDay(10))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: a 0 says the number is not valid and writes nothing (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping `.positive()` from the weeks schema (0 would be taken as the week before this one).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await moveField(sheet).fill("0");
    const sentence = sheet.getByText("Escribe un número entero de semanas, entre 1 y 520.", { exact: true });
    await expect(sentence).toBeVisible();
    await expect(moveField(sheet)).toHaveAttribute("aria-invalid", "true");
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    if (await move.isEnabled()) await move.click();
    await expect(sentence).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
  } finally {
    await context.close();
  }
});

test("E2: 4 weeks ends before the phase: refused naming week 6 counted from this week, nothing written (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: `weekIndexOf(openedOn, …)` in the phase sentence (it would say week 7); writing despite the phase.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await moveField(sheet).fill("4");
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    if (await move.isEnabled()) await move.click();
    await expect(
      sheet.getByText("La fase «Preparación» llega hasta la semana 6 (7 desde la apertura). El final no puede quedar antes.", { exact: true }),
    ).toBeVisible();
    await expect(moveField(sheet)).toHaveAttribute("aria-invalid", "true");
    await expect(dialog(page)).toBeVisible();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
    // Week 6 itself is the phase's last: not a refusal.
    await moveField(sheet).fill("6");
    await expect(sheet.getByText(/La fase «Preparación»/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("E2: 12 weeks passes the end of «Salud»: refused naming it and its last day, nothing written (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: the tree check judging a candidate counted from the opening (12 from the opening still fits under «Salud»).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await moveField(sheet).fill("12");
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    if (await move.isEnabled()) await move.click();
    await expect(sheet.getByText(`Pasa del final de «Salud», el ${lastDay(11)}.`, { exact: true })).toBeVisible();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
    // 11 ends exactly with «Salud»: not a refusal.
    await moveField(sheet).fill("11");
    await expect(sheet.getByText(/^Pasa del final de /)).toHaveCount(0);
    await expect(move).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("E2: with the action held, «Moverlo», «Quitar el final» and «Dejarlo como está» are disabled and a second tap sends nothing more (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: not disabling the sheet's buttons while the action is in flight.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await moveField(sheet).fill("10");
    await holdActions(page, 1500);
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await move.click();
    await expect(move).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Quitar el final", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Dejarlo como está", exact: true })).toBeDisabled();
    await move.dispatchEvent("click");
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(10));
  } finally {
    await context.close();
  }
});

test("E2: «Dejarlo como está» after typing 10 closes the sheet, keeps the end and the screen as they were (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: sending the typed number when the sheet is dismissed.
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openMove(page);
    await moveField(sheet).fill("10");
    await sheet.getByRole("button", { name: "Dejarlo como está", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
    await expect(page.getByText(new RegExp(`^9 semanas · hasta el ${escape(lastDay(8))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: moving «Salud» to week 7 offers «Mover también sus finales» with the dates counted from this week, and moves both (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: `later` judged against a candidate counted from the opening (it lists «Dormir mejor», which ends with the new end, as later).
  // Week 7 clears the phase (week 6): a phase past the new end would refuse the whole move.
  const { salud, correr } = await seedE2(db, person);
  // Ends exactly where week 7 from this week ends: not after it. Counted from the opening, week 7 ends a week earlier and it would be.
  const sueno = await seedOpenGoal(db, person, { name: "Dormir mejor", parent: salud, unit: MINUTES, horizon: fromThis(7), created: OPENED_LONG_AGO });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${salud}`);
  try {
    const sheet = await openMove(page);
    await expect(moveField(sheet)).toHaveValue("11");
    await moveField(sheet).fill("7");
    await expect(sheet.getByText("1 meta termina después de esta fecha", { exact: true })).toBeVisible();
    await expect(sheet).toContainText(`Correr 10 km · hasta el ${lastDay(8)}`);
    await expect(sheet.getByText("Dormir mejor")).toHaveCount(0);
    await expect(sheet).toContainText(`Con «Mover también sus finales» la meta termina el ${lastDay(7)}.`);
    await sheet.getByRole("button", { name: "Mover también sus finales", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, salud)).toBe(fromThis(7));
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(7));
    expect(await horizonOfGoal(db, sueno)).toBe(fromThis(7));
  } finally {
    await context.close();
  }
});

test("u7: a goal that ended reopens on 1 counted from this week, ending this Sunday; 4 lands the Monday after week 4 from this week (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: `anchor = reopening ? openedOn : today` (the sheet opens on the weeks since the opening, labelled «contando la del …»).
  const id = await seedOpenGoal(db, person, { name: "Terminada", horizon: todayInZone(), created: new Date(Date.now() - 20 * 86_400_000) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openMove(page);
    await expect(moveField(sheet)).toHaveValue("1");
    await expect(sheet.getByLabel(/contando la del/)).toHaveCount(0);
    await expect(sheet.getByText(new RegExp(`^termina el ${escape(lastDay(1))} · \\d+ semanas? en total$`))).toBeVisible();
    await moveField(sheet).fill("4");
    await expect(sheet.getByText(new RegExp(`^termina el ${escape(lastDay(4))} · \\d+ semanas? en total$`))).toBeVisible();
    await sheet.getByRole("button", { name: "Ponerle final", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(4));
  } finally {
    await context.close();
  }
});

test("at 360 the move sheet with a refusal does not overflow the screen (RP-108)", async ({ person, browser, baseURL, db }) => {
  // Kills: a refusal or a hint wider than the sheet (a notice drawn outside `components/ui`).
  const { correr } = await seedE2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`, 360);
  try {
    const sheet = await openMove(page);
    await moveField(sheet).fill("4");
    const move = sheet.getByRole("button", { name: "Moverlo", exact: true });
    if (await move.isEnabled()) await move.click();
    await expect(sheet.getByText(/^La fase «Preparación» llega hasta la semana 6 \(7 desde la apertura\)/)).toBeVisible();
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
