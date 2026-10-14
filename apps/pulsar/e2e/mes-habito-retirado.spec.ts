import type { Locator, Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { figure } from "./habit-weeks";
import { mainLower, visit } from "./metas-sin-final-seed";
import { type Days, serverDays } from "./server-day";
import { seedFact, seedHabit, shift } from "./sin-final-seed";

// Module 948, RP-113: in «Mes», a habit retired this month keeps its line and gets «retirado el {d mmm}» on its own line
// under it, in the month it was retired and no other. Board MesRetirado (H1–H4 of private/contrato-948.md), decision of
// 2026-10-13 in docs/pulsar/DESIGN.md. Written from the contract before the screen draws the line.
// The day is the one the server reads (`serverDays`), so the spec says the same thing on any day of the week or month.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const shortOf = (day: string) => `${Number(day.slice(8, 10))} ${ABBR[Number(day.slice(5, 7)) - 1]}`;
const retiredLine = (day: string) => `retirado el ${shortOf(day)}`;

let D: Days;
test.beforeEach(async ({ browser, baseURL, person }) => {
  D = await serverDays(browser, baseURL, person);
});

const mondaysUntilNow = () => {
  const mondays: string[] = [];
  for (let monday = D.eightWeeksAgo; monday <= D.weekStart; monday = shift(monday, 7)) mondays.push(monday);
  return mondays;
};

// H1 on the server's day: «Yoga» (2 a week) retired today after meeting this week, «Llamar a mamá» (1 a week) alive, both
// with a fact every Monday since 8 weeks back (and «Yoga» every Tuesday that has come). The weeks the month counts for a
// habit retired today are every closed week of the month plus the one in progress when it is met.
async function h1(db: import("./meta-arbol-seed").Db, personId: string, retiredAt: Date = noonOf(D.today)) {
  const created = noonOf(D.eightWeeksAgo);
  const yoga = await seedHabit(db, personId, "Yoga", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created, retired: retiredAt });
  const call = await seedHabit(db, personId, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created });
  for (const monday of mondaysUntilNow()) {
    await seedFact(db, personId, yoga, null, monday);
    if (shift(monday, 1) <= D.today) await seedFact(db, personId, yoga, null, shift(monday, 1));
    await seedFact(db, personId, call, null, monday);
  }
  const month = D.today.slice(0, 7);
  const closedBefore = mondaysUntilNow().filter((monday) => monday < D.weekStart && shift(monday, 3).slice(0, 7) === month).length;
  // On a Monday the week in progress holds one «Yoga» fact of the two it asks: not met, so not counted.
  const weekMet = shift(D.weekStart, 1) <= D.today;
  return { yoga, call, counted: closedBefore + (weekMet ? 1 : 0) };
}

// The element that holds exactly this text (a `Text` of its own), or none.
const line = (page: Page, text: string): Locator => page.locator("main p", { hasText: new RegExp(`^\\s*${text}\\s*$`, "i") });

async function fits360(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > 360) bad.push(`scrollWidth ${document.documentElement.scrollWidth}`);
    for (const el of Array.from(document.querySelectorAll("main a[href], main button"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (Math.min(r.width, r.height) < 32) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} ${r.width}x${r.height}`);
      if (r.right > 360.5) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} right ${r.right}`);
    }
    return bad;
  });
}

test.describe("a habit retired this month in «Mes» (RP-113)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("H1: «Yoga» keeps its weekly line, «retirado el {hoy}» sits under it in its own line with no «esta semana»; the live habit beside it has none", async ({ person, browser, baseURL, db }) => {
    // Kills: the retirement not drawn (b3442d67); drawn on the same line after «·»; «esta semana» kept on a retired habit; the mark
    // put on every habit; a year or a weekday in the short date.
    const { counted } = await h1(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(page);
      const weekly = `2 veces por semana · ${counted === 0 ? "aún sin semanas cerradas" : figure(counted, counted)}`;
      const mark = retiredLine(D.today);
      const wordsOfLine = line(page, `yoga`);
      await expect(wordsOfLine.first()).toBeVisible();
      expect(text).toContain(`yoga ${weekly} ${mark}`);
      expect(text).not.toContain("· retirado");
      const retired = line(page, mark);
      await expect(retired).toHaveCount(1);
      const lineOfYoga = line(page, weekly);
      await expect(lineOfYoga).toHaveCount(1);
      const upper = (await lineOfYoga.boundingBox())!;
      const lower = (await retired.boundingBox())!;
      expect(lower.y).toBeGreaterThanOrEqual(upper.y + upper.height - 1);
      const holder = retired.locator("xpath=..");
      expect((await holder.innerText()).toLowerCase()).not.toContain("esta semana");
      expect(text.split("retirado").length - 1).toBe(1);
      expect(text).toContain(`llamar a mamá 1 vez por semana · `);
      expect(text).toMatch(/1 vez por semana · [^·]*· 1 de 1 esta semana/);
    } finally {
      await context.close();
    }
  });

  test("the name of the retired habit is not dimmed: same colour and opacity as a live habit's, and it links to its screen back to /mes", async ({ person, browser, baseURL, db }) => {
    // Kills: dimming the retired name; the name drawn as plain text for a retired habit; a link without `volver`.
    const { yoga } = await h1(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      await mainLower(page);
      await expect(line(page, retiredLine(D.today))).toHaveCount(1);
      const yogaLink = page.locator("main").getByRole("link", { name: "Yoga", exact: true });
      const liveLink = page.locator("main").getByRole("link", { name: "Llamar a mamá", exact: true });
      await expect(yogaLink).toHaveAttribute("href", `/metas/habitos/${yoga}?volver=/mes`);
      const look = (link: Locator) =>
        link.evaluate((el) => {
          let opacity = 1;
          for (let node: Element | null = el; node && node.tagName !== "BODY"; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
          const name = el.parentElement!;
          const style = getComputedStyle(name);
          return { link: getComputedStyle(el).color, name: style.color, weight: style.fontWeight, size: style.fontSize, opacity };
        });
      expect(await look(yogaLink)).toEqual(await look(liveLink));
    } finally {
      await context.close();
    }
  });

  test("the link opens the habit's screen, which says «retirado el {fecha} {año}»", async ({ person, browser, baseURL, db }) => {
    // Kills: the retired name left without a link in «Mes».
    const { yoga } = await h1(db, person.id);
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      await mainLower(page);
      await expect(line(page, retiredLine(D.today))).toHaveCount(1);
      await page.locator("main").getByRole("link", { name: "Yoga", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/habitos/${yoga}`));
      expect(await mainLower(page)).toContain(`${retiredLine(D.today)} ${D.today.slice(0, 4)}`);
    } finally {
      await context.close();
    }
  });

  test("H2: a daily habit retired this month reads «todos los días · 0 de N días» and under it «retirado el {fecha}»", async ({ person, browser, baseURL, db }) => {
    // Kills: the mark drawn only for the weekly branch.
    await seedHabit(db, person.id, "Leer antes de dormir", { kind: "daily" }, { kind: "tap" }, { created: noonOf(shift(D.today, -40)), retired: noonOf(D.today) });
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(page);
      expect(text).toMatch(new RegExp(`leer antes de dormir todos los días · 0 de \\d+ días? ${retiredLine(D.today)}`));
      const retired = line(page, retiredLine(D.today));
      await expect(retired).toHaveCount(1);
      expect((await line(page, "todos los días · 0 de \\d+ días?").boundingBox())!.y).toBeLessThan((await retired.boundingBox())!.y);
    } finally {
      await context.close();
    }
  });

  test("H3: retired today at 23:30 in Bogotá (04:30 UTC tomorrow) reads «retirado el {hoy}», never tomorrow's date", async ({ person, browser, baseURL, db }) => {
    // Kills: the date of `retired_at` taken in UTC.
    await h1(db, person.id, new Date(`${D.today}T23:30:00-05:00`));
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      await mainLower(page);
      await expect(line(page, retiredLine(D.today))).toHaveCount(1);
      await expect(line(page, retiredLine(shift(D.today, 1)))).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("H4: a habit retired in an earlier month is not in «Mes» and nothing says «retirado»; the live ones stay", async ({ person, browser, baseURL, db }) => {
    // Kills: listing every retired habit.
    const created = noonOf(shift(D.today, -90));
    const lastMonthDay = shift(`${D.today.slice(0, 7)}-01`, -1);
    await seedHabit(db, person.id, "Yoga viejo", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created, retired: noonOf(lastMonthDay) });
    await seedHabit(db, person.id, "Tomar agua", { kind: "daily" }, { kind: "tap" }, { created });
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain("tomar agua todos los días");
      expect(text).not.toContain("yoga viejo");
      expect(text).not.toContain("retirado");
    } finally {
      await context.close();
    }
  });

  test("a retired habit with a long name keeps its two lines inside 360 and every target at 32 or more", async ({ person, browser, baseURL, db }) => {
    // Kills: the retirement line drawn outside `components/ui` with a fixed width; a line that overflows at 360.
    const created = noonOf(D.eightWeeksAgo);
    const name = "Estirar la espalda y los hombros antes de salir";
    const id = await seedHabit(db, person.id, name, { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created, retired: noonOf(D.today) });
    for (const monday of mondaysUntilNow()) await seedFact(db, person.id, id, null, monday);
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      await mainLower(page);
      await expect(line(page, retiredLine(D.today))).toHaveCount(1);
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
