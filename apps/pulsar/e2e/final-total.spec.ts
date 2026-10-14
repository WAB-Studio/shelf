import type { Browser, Locator, Page } from "@playwright/test";

import { civilDateToDate, civilDayMonthYear, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, visit, type Person } from "./fixtures";
import { holdActions } from "./meta-arbol-seed";
import type { Db } from "./meta-arbol-seed";
import { MINUTES, dialog, horizonOfGoal, postCounter, seedOpenGoal } from "./metas-sin-final-seed";

// Module 946, RP-114: the end sheet says the total the goal will read, «termina el 3 ene 2027 · 113 semanas en total»,
// the goal screen's own count (opening week to the end); while a refusal holds the hint the total moves to the line
// of the two counts; an ended goal reopens on «Ponerle final» / «Dejarla sin final». Board FinalTotal
// (private/tableros-s5/NOTAS.md §2); the user's decision of 2026-10-13. The totals are plain Monday arithmetic here,
// never the app's own week helpers; the spec follows PULSAR_CLOCK. Every test names the mutation that kills it.

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
const weeks = (n: number) => `${n} ${n === 1 ? "semana" : "semanas"}`;
// Weeks the goal has lived, this one included.
const lives = (opened: string) =>
  Math.round((civilDateToDate(MONDAY).getTime() - civilDateToDate(weekOf(opened)[0]).getTime()) / DAY_MS / 7) + 1;
// The total of an end `n` weeks from this one: the goal's weeks from its opening week to that end.
const total = (opened: string, n: number) => lives(opened) + n - 1;
const hintOf = (opened: string, n: number) => `termina el ${lastDay(n)} · ${weeks(total(opened, n))} en total`;
const line = (lived: number, shown?: number) =>
  `contando desde esta semana; la meta lleva ${weeks(lived)}${shown === undefined ? "" : ` · ${weeks(shown)} en total`}`;

const OPENED_LONG_AGO = "2024-11-05";
const OPENED_LAST_MONDAY = plusDays(MONDAY, -7);
const OPENED_8_WEEKS_AGO = plusDays(MONDAY, -49);
const INVALID = "Escribe un número entero de semanas, entre 1 y 520.";

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
const button = (sheet: Locator, name: string) => sheet.getByRole("button", { name, exact: true });

// F2: «Correr 10 km» opened last Monday, ends 8 weeks from this one, inside «Salud» (ends in week 11); phase «Preparación»
// ends on the Sunday of week 6 from this one.
async function seedF2(db: Db, person: Person) {
  const salud = await seedOpenGoal(db, person, { name: "Salud", unit: MINUTES, horizon: fromThis(11), created: at(OPENED_LONG_AGO) });
  const correr = await seedOpenGoal(db, person, {
    name: "Correr 10 km",
    parent: salud,
    unit: MINUTES,
    horizon: fromThis(8),
    created: at(OPENED_LAST_MONDAY),
  });
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${correr}, 'Preparación', ${OPENED_LAST_MONDAY}, ${plusDays(fromThis(6), -1)})`;
  return { salud, correr };
}

// F4: ended, opened 8 weeks ago; the horizon is this Monday, so the goal ended yesterday.
async function seedF4(db: Db, person: Person, parent: string | null = null) {
  return seedOpenGoal(db, person, { name: "Pintar la sala", parent, unit: MINUTES, horizon: MONDAY, created: at(OPENED_8_WEEKS_AGO) });
}

test("F1: «Leer», no end, opened 5 nov 2024: the hint adds the total the screen will read, and the screen reads it (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: `total = N` (the hint says 12 semanas en total); the total counted from this week.
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: at(OPENED_LONG_AGO) });
  const n = lives(OPENED_LONG_AGO);
  expect(n).toBeGreaterThanOrEqual(102);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "ponerle final");
    await expect(field(sheet)).toHaveValue("12");
    await expect(sheet.getByText(hintOf(OPENED_LONG_AGO, 12), { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(n), { exact: true })).toBeVisible();
    await button(sheet, "Ponerle final").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(12));
    await expect(page.getByText(new RegExp(`^${n + 11} semanas · hasta el ${escape(lastDay(12))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F2: untouched, «mover el final» opens on 8 and the hint's total is the screen's 9 (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: counting the total from today (`weekIndexOf(hoy, …)`: 8), or from the written Monday instead of the stored end.
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    await expect(page.getByText(new RegExp(`^9 semanas · hasta el ${escape(lastDay(8))}$`))).toBeVisible();
    const sheet = await openSheet(page, "mover el final");
    await expect(field(sheet)).toHaveValue("8");
    await expect(sheet.getByText(`termina el ${lastDay(8)} · 9 semanas en total`, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F2: writing 10 hints 11 semanas en total, and once moved the screen reads 11 (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: the total of the stored horizon instead of the typed one (stays 9).
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("10");
    await expect(sheet.getByText(`termina el ${lastDay(10)} · 11 semanas en total`, { exact: true })).toBeVisible();
    await button(sheet, "Moverlo").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(10));
    await expect(page.getByText(new RegExp(`^11 semanas · hasta el ${escape(lastDay(10))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F3: a goal opened this week, ending in 1, says «1 semana en total» in the singular (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: a fixed plural («1 semanas en total»).
  const id = await seedOpenGoal(db, person, { name: "Recién", unit: MINUTES, horizon: null, created: at(MONDAY) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`);
  try {
    const sheet = await openSheet(page, "ponerle final");
    await field(sheet).fill("1");
    await expect(sheet.getByText(`termina el ${lastDay(1)} · 1 semana en total`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(1), { exact: true })).toBeVisible();
    await expect(sheet.getByText(/1 semanas/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("F2: 4 is refused by the phase: the hint is the refusal alone, the total goes to the line of the two counts, then back on 10 (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: losing the total with the refusal; leaving it in the hint; leaving it in the line after the refusal is gone.
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("4");
    const move = button(sheet, "Moverlo");
    if (await move.isEnabled()) await move.click();
    const refusal = sheet.getByText("La fase «Preparación» llega hasta la semana 6 (7 desde la apertura). El final no puede quedar antes.", { exact: true });
    await expect(refusal).toBeVisible();
    await expect(refusal).not.toContainText("en total");
    await expect(sheet.getByText(line(2, 5), { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(2), { exact: true })).toHaveCount(0);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));

    await field(sheet).fill("10");
    await expect(sheet.getByText(`termina el ${lastDay(10)} · 11 semanas en total`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(2, 5), { exact: true })).toHaveCount(0);
    await expect(sheet.getByText(/en total/)).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("F2: 30 passes the end of «Salud»: the tree's sentence holds the hint and the total sits in the line (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: the total moved to the line only for a phase refusal; the tree sentence carrying «en total».
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("30");
    const sentence = sheet.getByText(`Pasa del final de «Salud», el ${lastDay(11)}.`, { exact: true });
    await expect(sentence).toBeVisible();
    await expect(sentence).not.toContainText("en total");
    await expect(sheet.getByText(line(2, 31), { exact: true })).toBeVisible();
    await expect(sheet.getByText(/^termina el /)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("F2: a 0, an empty field and a 521 say the number is not valid and no «en total» stands anywhere (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: a total of NaN (or of the previous number) drawn beside an invalid count.
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const sheet = await openSheet(page, "mover el final");
    for (const typed of ["0", "", "521"]) {
      await field(sheet).fill(typed);
      await expect(sheet.getByText(INVALID, { exact: true })).toBeVisible();
      await expect(sheet.getByText(/en total/)).toHaveCount(0);
      await expect(sheet.getByText(line(2), { exact: true })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("F4 at 1280: an ended goal's sheet offers «Dejarla sin final» and «Ponerle final», counts 8 weeks and never «Quitar el final», «Moverlo» or «Dejarlo como está» (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: `noEnd` read without `reopening` (the s4 buttons come back); the hint without the total.
  const id = await seedF4(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 1280);
  try {
    const sheet = await openSheet(page, "mover el final");
    await expect(field(sheet)).toHaveValue("1");
    await expect(sheet.getByText(`termina el ${lastDay(1)} · 8 semanas en total`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(8), { exact: true })).toBeVisible();
    for (const gone of ["Quitar el final", "Moverlo", "Dejarlo como está"]) await expect(button(sheet, gone)).toHaveCount(0);
    await expect(button(sheet, "Dejarla sin final")).toBeVisible();
    await expect(button(sheet, "Ponerle final")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F4 at 360: the same two buttons on the phone (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: the phone face keeping the s4 buttons.
  const id = await seedF4(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 360);
  try {
    const sheet = await openSheet(page, "mover el final");
    await expect(sheet.getByText(`termina el ${lastDay(1)} · 8 semanas en total`, { exact: true })).toBeVisible();
    for (const gone of ["Quitar el final", "Moverlo", "Dejarlo como está"]) await expect(button(sheet, gone)).toHaveCount(0);
    await expect(button(sheet, "Dejarla sin final")).toBeVisible();
    await expect(button(sheet, "Ponerle final")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F4: «Ponerle final» with the field untouched (1) writes the Monday after this week and the goal reads 8 semanas (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: treating the untouched field of a reopening as «sin tocar» (nothing written, the goal stays ended).
  const id = await seedF4(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 1280);
  try {
    const sheet = await openSheet(page, "mover el final");
    await expect(field(sheet)).toHaveValue("1");
    await button(sheet, "Ponerle final").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(1));
    await expect(page.getByText(/^terminó el /)).toHaveCount(0);
    await expect(page.getByText(new RegExp(`^8 semanas · hasta el ${escape(lastDay(1))}$`))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F4: «Dejarla sin final» takes the end off: the goal reopens with no end, and a second tap writes nothing more (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: «Dejarla sin final» wired to close without writing, or to write the Monday after this week.
  const id = await seedF4(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 1280);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    const leave = button(sheet, "Dejarla sin final");
    await leave.click();
    await leave.dispatchEvent("click").catch(() => undefined);
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, id)).toBeNull();
    expect(posts).toHaveLength(1);
    await expect(page.getByText(/^terminó el /)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Añadir un compromiso" })).toBeVisible();
    await expect(page.locator("main").first()).toContainText("sin final");
    await expect(page.getByRole("button", { name: "ponerle final" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("F5: reopening inside «Casa»: «Dejarla sin final» is refused with the tree's sentence and writes nothing; «Ponerle final» with 3 writes (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: skipping the tree check on «Dejarla sin final»; refusing «Ponerle final» too.
  const casa = await seedOpenGoal(db, person, { name: "Casa", unit: MINUTES, horizon: fromThis(10), created: at(OPENED_LONG_AGO) });
  const sala = await seedF4(db, person, casa);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${sala}`, 1280);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await button(sheet, "Dejarla sin final").click();
    await expect(sheet.getByText(`Pasa del final de «Casa», el ${lastDay(10)}.`, { exact: true })).toBeVisible();
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, sala)).toBe(MONDAY);

    await field(sheet).fill("3");
    await button(sheet, "Ponerle final").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await horizonOfGoal(db, sala)).toBe(fromThis(3));
  } finally {
    await context.close();
  }
});

test("F4: with the action held, both reopen buttons are disabled, a second tap sends nothing and the hint and line stay (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: not disabling the reopen buttons while the action is in flight.
  const id = await seedF4(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}`, 1280);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("3");
    await holdActions(page, 1500);
    const put = button(sheet, "Ponerle final");
    await put.click();
    await expect(put).toBeDisabled();
    await expect(button(sheet, "Dejarla sin final")).toBeDisabled();
    await expect(sheet.getByText(`termina el ${lastDay(3)} · 10 semanas en total`, { exact: true })).toBeVisible();
    await expect(sheet.getByText(line(8), { exact: true })).toBeVisible();
    await put.dispatchEvent("click");
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(await horizonOfGoal(db, id)).toBe(fromThis(3));
  } finally {
    await context.close();
  }
});

test("«Dejarlo como está» after typing 10 closes the sheet and the horizon stays (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: sending the typed number when the sheet is dismissed.
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const posts = postCounter(page);
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("10");
    await button(sheet, "Dejarlo como está").click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(posts).toEqual([]);
    expect(await horizonOfGoal(db, correr)).toBe(fromThis(8));
  } finally {
    await context.close();
  }
});

test("the other sheets keep their buttons: a goal with no end offers «Ponerle final» / «Dejarla sin final», one with an end still offers «Quitar el final» (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: removing «Quitar el final» from every sheet, or giving the no-end sheet the s4 move buttons.
  const endless = await seedOpenGoal(db, person, { name: "Leer", unit: MINUTES, horizon: null, created: at(OPENED_LONG_AGO) });
  const { correr } = await seedF2(db, person);
  const a = await open(browser, baseURL, person.sessionFile, `/metas/${endless}`);
  const b = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`);
  try {
    const put = await openSheet(a.page, "ponerle final");
    await expect(button(put, "Ponerle final")).toBeVisible();
    await expect(button(put, "Dejarla sin final")).toBeVisible();
    await expect(button(put, "Quitar el final")).toHaveCount(0);
    const move = await openSheet(b.page, "mover el final");
    await expect(button(move, "Quitar el final")).toBeVisible();
    await expect(button(move, "Moverlo")).toBeVisible();
    await expect(button(move, "Dejarlo como está")).toBeVisible();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("at 360 the longest hint and the refusal with the line's total do not overflow the screen (RP-114)", async ({ person, browser, baseURL, db }) => {
  // Kills: a hint or a line wider than the sheet (a text drawn outside `components/ui`).
  const { correr } = await seedF2(db, person);
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${correr}`, 360);
  const overflow = () =>
    page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
      const box = dlg.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sheet: dlg.scrollWidth - dlg.clientWidth,
        right: box.right - window.innerWidth,
        left: box.left,
      };
    });
  try {
    const sheet = await openSheet(page, "mover el final");
    await field(sheet).fill("10");
    await expect(sheet.getByText(`termina el ${lastDay(10)} · 11 semanas en total`, { exact: true })).toBeVisible();
    let over = await overflow();
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.sheet).toBeLessThanOrEqual(0);
    expect(over.right).toBeLessThanOrEqual(0);
    expect(over.left).toBeGreaterThanOrEqual(0);

    await field(sheet).fill("4");
    const move = button(sheet, "Moverlo");
    if (await move.isEnabled()) await move.click();
    await expect(sheet.getByText(line(2, 5), { exact: true })).toBeVisible();
    over = await overflow();
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.sheet).toBeLessThanOrEqual(0);
    expect(over.right).toBeLessThanOrEqual(0);
    expect(over.left).toBeGreaterThanOrEqual(0);
  } finally {
    await context.close();
  }
});
