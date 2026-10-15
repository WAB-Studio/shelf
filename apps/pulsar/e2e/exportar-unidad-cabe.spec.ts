import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, settled, type Person } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Module 823 (RP-28, RP-32, RP-35), the critic's `exportar-360-vocab.png` and `exportar-1024-vocab.png`: on `/exportar`
// the «Por mes» list of a goal measured in `searches` says «de 60 búsquedas» for a started month. It stays inside its
// row and its card at 360 and at 1024, «de» never stands alone apart from its number, and a time goal's note keeps one line.

const today = todayInZone();
const thisMonth = monthOf(today);
const lastMonth = monthOf(dayBefore(thisMonth));
const horizon = nextMonth(nextMonth(nextMonth(thisMonth)));

type Unit = { measure: string; unit: string };
const SEARCHES: Unit = { measure: "búsquedas", unit: "searches" };
const KM: Unit = { measure: "kilómetros", unit: "km" };
const MINUTES: Unit = { measure: "minutos", unit: "minutos" };

async function seedGoal(db: postgres.Sql, person: Person, unit: Unit, budget: number, done: number | null): Promise<void> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta ${Date.now()}`}, ${horizon}::date, ${unit.measure}, ${unit.unit},
            (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id`;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${thisMonth}::date, ${budget})`;
  if (done !== null) {
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, 'Ronda', 'daily', 'quantity', 5, ${unit.unit}, now() - interval '60 days')
      returning id`;
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
      values (${person.id}, ${commitment.id}, ${goal.id}, ${today}::date, ${done})`;
  }
}

type Measure = {
  rowRight: number;
  rowLeft: number;
  cardRight: number;
  noteRight: number;
  noteLeft: number;
  noteHeight: number;
  lineHeight: number;
  noteText: string;
  noteTop: number;
  labelTop: number;
  labelBottom: number;
  deTop: number | null;
  figureTop: number | null;
  scrollWidth: number;
  viewport: number;
};

// The `person` fixture's own rows are read through its own session, never the page fixture's seeded person.
async function open(browser: Browser, baseURL: string | undefined, person: Person, width: number) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/exportar");
  await settled(page);
  return { page, close: () => context.close() };
}

// The visible «Por mes» row of the current month: its note is the `stackNote` span.
async function measure(page: Page, figure: string): Promise<Measure> {
  const row = page.locator("main ol li:visible").filter({ hasText: /en curso/i }).first();
  await expect(row).toBeVisible();
  return row.evaluate((li, wanted) => {
    const note = li.querySelector<HTMLElement>('[data-part="table-stack-note"]')!;
    const rect = (el: Element) => el.getBoundingClientRect();
    // The card is the nearest ancestor that paints its own box.
    let card: Element = li;
    while (card.parentElement && card.parentElement !== document.body) {
      card = card.parentElement;
      const style = getComputedStyle(card);
      if (style.borderTopWidth !== "0px" && style.borderTopStyle !== "none" && card.tagName !== "OL") break;
    }
    const tops = (match: (text: string) => boolean): number | null => {
      const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        if (!match(text)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const first = range.getClientRects()[0];
        if (first) return Math.round(first.top);
      }
      return null;
    };
    const label = li.querySelector<HTMLElement>('[data-part="table-stack-label"]')!;
    return {
      noteTop: rect(note).top,
      labelTop: rect(label).top,
      labelBottom: rect(label).bottom,
      rowRight: rect(li).right,
      rowLeft: rect(li).left,
      cardRight: rect(card).right,
      noteRight: rect(note).right,
      noteLeft: rect(note).left,
      noteHeight: rect(note).height,
      lineHeight: parseFloat(getComputedStyle(note).lineHeight),
      noteText: (note.textContent ?? "").replace(/\s+/g, " ").trim(),
      deTop: tops((t) => /^\s*de\s*$/.test(t)),
      figureTop: tops((t) => t.trim() === wanted),
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  }, figure);
}

function fits(m: Measure) {
  expect(m.noteRight, "the note's right edge stays inside its row").toBeLessThanOrEqual(m.rowRight + 0.5);
  expect(m.noteRight, "the note's right edge stays inside its card").toBeLessThanOrEqual(m.cardRight + 0.5);
  expect(m.noteLeft, "the note's left edge stays inside its row").toBeGreaterThanOrEqual(m.rowLeft - 0.5);
  expect(m.scrollWidth, "the page scrolls sideways").toBeLessThanOrEqual(m.viewport);
}

for (const width of [360, 1024]) {
  for (const done of [null, 30]) {
    test(`/exportar at ${width}: «${done ?? 0} de 60 búsquedas» fits its row and keeps «de» with the number`, async ({ browser, baseURL, db, person }) => {
      await seedGoal(db, person, SEARCHES, 60, done);
      const { page, close } = await open(browser, baseURL, person, width);
      const m = await measure(page, "60").finally(close);
      fits(m);
      expect(m.noteText).toMatch(/de\s*60\s*búsquedas$/);
      expect(m.deTop, "«de» is a text of its own in the note").not.toBeNull();
      expect(m.figureTop, "«60» is found in the note").not.toBeNull();
      expect(m.deTop, "«de» stands on the line of «60»").toBe(m.figureTop);
    });
  }

  test(`/exportar at ${width}: a time goal's note keeps one line inside its row`, async ({ browser, baseURL, db, person }) => {
    await seedGoal(db, person, MINUTES, 720, 90);
    const { page, close } = await open(browser, baseURL, person, width);
    const m = await measure(page, "12").finally(close);
    fits(m);
    expect(m.noteText).toMatch(/^de /);
    expect(m.noteHeight, "one line").toBeLessThan(m.lineHeight * 1.5);
  });
}

// A short unit at a tight width: «de» is never left at the end of a line apart from «40».
for (const width of [360, 270, 260, 250]) {
  test(`/exportar at ${width}: «20 de 40 km» keeps «de» on the line of «40»`, async ({ browser, baseURL, db, person }) => {
    await seedGoal(db, person, KM, 40, 20);
    const { page, close } = await open(browser, baseURL, person, width);
    const m = await measure(page, "40").finally(close);
    expect(m.noteText).toMatch(/de\s*40\s*km$/);
    expect(m.deTop, "«de» is a text of its own in the note").not.toBeNull();
    expect(m.figureTop, "«40» is found in the note").not.toBeNull();
    expect(m.deTop, "«de» stands on the line of «40»").toBe(m.figureTop);
  });
}

// At 360 the unit word drops under «de 60» but the note stays beside the label: the row does not grow a line.
test("/exportar at 360: «de 60 búsquedas» sits beside the label, not on a line of its own below", async ({ browser, baseURL, db, person }) => {
  await seedGoal(db, person, SEARCHES, 60, 30);
  const { page, close } = await open(browser, baseURL, person, 360);
  const m = await measure(page, "60").finally(close);
  expect(m.noteTop, "the note starts on the label's line").toBeLessThan(m.labelBottom - 1);
  expect(m.noteTop, "the note does not start below the label's top line").toBeLessThan(m.labelTop + m.lineHeight);
});

// A time note never splits inside («de 7 h 15 min» is one line) and never leaves its row. Where it does not fit beside
// the label it drops whole under it; where it fits it stays beside it. The wide face from 1280 is another table.
for (const width of [300, 320, 340, 1024]) {
  test(`/exportar at ${width}: a long time note «de 7 h 15 min» is one line and stays inside its row`, async ({ browser, baseURL, db, person }) => {
    await seedGoal(db, person, MINUTES, 435, 90);
    const { page, close } = await open(browser, baseURL, person, width);
    const m = await measure(page, "7").finally(close);
    expect(m.noteText).toBe("de 7 h 15 min");
    expect.soft(m.noteHeight, "one line").toBeLessThan(m.lineHeight * 1.5);
    expect.soft(m.noteRight, "the note's right edge stays inside its row").toBeLessThanOrEqual(m.rowRight + 0.5);
  });
}

test("/exportar at 360: «de 7 h 15 min» fits beside the label and stays there", async ({ browser, baseURL, db, person }) => {
  await seedGoal(db, person, MINUTES, 435, 90);
  const { page, close } = await open(browser, baseURL, person, 360);
  const m = await measure(page, "7").finally(close);
  expect(m.noteText).toBe("de 7 h 15 min");
  expect(m.noteTop, "the note starts on the label's line").toBeLessThan(m.labelBottom - 1);
  expect(m.noteTop, "the note does not start below the label's top line").toBeLessThan(m.labelTop + m.lineHeight);
});
