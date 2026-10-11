import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `MesesListaDetalle.dc.html` (RP-32, RNP-17): the goal's months
// beside the open month keep the list at 320px. «sin monto» there reads on
// whole words at every width; at 1024 it may wrap and the chevron stays in its
// row, at 360 and from 1280 it keeps one line (826, decision 4).

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));

for (const width of [360, 1280, 1440]) {
  test(`at ${width}px «sin monto» in the months list is one line and no note is narrower than its longest word (RP-32)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta angosta ${width} ${Date.now()}`}, ${thisMonth}::date + 62, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
      returning id
    `;
    // A past month with reached time: the long figure is what squeezes the note.
    const [done] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goal.id}, 'Hecha', ${lastMonth}::date, 6000) returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${goal.id}, ${done.id}, ${lastMonth}::date + 14)
    `;
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goal.id}/meses`);
      const notes = page.locator("main li span").filter({ hasText: /^sin monto$/ });
      await expect(notes.first()).toBeVisible();

      const measures = await notes.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          // The same span with its words on one line: the height one line takes.
          const probe = node.cloneNode(true) as HTMLElement;
          probe.style.whiteSpace = "nowrap";
          probe.style.visibility = "hidden";
          node.after(probe);
          const { height: oneLine } = probe.getBoundingClientRect();
          probe.remove();
          const mono = document.createElement("span");
          mono.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
          mono.style.font = style.font;
          mono.style.letterSpacing = style.letterSpacing;
          mono.textContent = "monto";
          document.body.append(mono);
          const word = mono.getBoundingClientRect().width;
          mono.remove();
          const box = node.getBoundingClientRect();
          return { height: box.height, line: oneLine, width: box.width, word };
        }),
      );
      expect(measures.length).toBeGreaterThan(0);
      for (const m of measures) {
        expect(m.height).toBeLessThanOrEqual(m.line + 1);
        expect(m.width).toBeGreaterThanOrEqual(m.word - 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
    }
  });
}

test("at 1024px «sin monto» of a time goal may wrap: every chevron stays inside its row and no word is split (826)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta angosta 1024 ${Date.now()}`}, ${thisMonth}::date + 62, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, 'Hecha', ${lastMonth}::date, 6000) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${done.id}, ${lastMonth}::date + 14)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`/metas/${goal.id}/meses`);
    const notes = page.locator("main li span").filter({ hasText: /^sin monto$/ });
    await expect(notes.first()).toBeVisible();

    const rows = await page.locator("main ol > li").evaluateAll((items) =>
      items.map((li) => {
        const box = li.getBoundingClientRect();
        const chevron = li.querySelector("svg")?.getBoundingClientRect();
        return { chevronPast: chevron ? chevron.right - box.right : null };
      }),
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.chevronPast).not.toBeNull();
      expect(row.chevronPast!).toBeLessThanOrEqual(0.5);
    }

    // A wrap falls between words: the note is never narrower than «monto».
    const widths = await notes.evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        const mono = document.createElement("span");
        mono.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
        mono.style.font = style.font;
        mono.style.letterSpacing = style.letterSpacing;
        mono.textContent = "monto";
        document.body.append(mono);
        const word = mono.getBoundingClientRect().width;
        mono.remove();
        return { width: node.getBoundingClientRect().width, word };
      }),
    );
    for (const m of widths) expect(m.width).toBeGreaterThanOrEqual(m.word - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

// 843 (RP-32, RP-76): a time note that does not fit beside its month drops whole
// under it, as on paper; it never splits («de / 8 h / 03 / min») and never pushes
// the chevron out of its row, at any width. One that fits stays on the month's line.

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function lengthOfMonth(month: string): number {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
}

function timeWords(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  return [h ? `${h} h` : "", min ? `${min} min` : ""].filter(Boolean).join(" ");
}

// RP-76: the rhythm spread over the month's days, times the goal's days in it, rounded down.
function shareOpenedOn(day: number, month: string, rhythm: number): number {
  const length = lengthOfMonth(month);
  return Math.floor((rhythm * (length - day + 1)) / length);
}

// The month the goal opens in and the day: a share with both hours and minutes,
// whichever day the suite runs on. Opens in this month while a day from the 2nd to
// today gives one, last month otherwise.
function openingForLongShare(rhythm: number): { month: string; day: number; share: number } {
  const today = Number(todayInZone().slice(8, 10));
  for (const [month, last] of [[thisMonth, today], [lastMonth, lengthOfMonth(lastMonth)]] as const) {
    for (let day = 2; day <= last; day++) {
      const share = shareOpenedOn(day, month, rhythm);
      if (share >= 120 && share % 60 !== 0) return { month, day, share };
    }
  }
  throw new Error("no opening day gives a share with hours and minutes");
}

type NoteMeasure = {
  text: string;
  month: string;
  lines: number;
  noteRight: number;
  chevronRight: number | null;
  rowRight: number;
  sameLineAsMonth: boolean;
};

async function measureNotes(page: import("@playwright/test").Page): Promise<NoteMeasure[]> {
  return page.locator("main ol > li").evaluateAll((items, names) => {
    const out: NoteMeasure[] = [];
    for (const li of items) {
      const row = li.getBoundingClientRect();
      const spans = Array.from(li.querySelectorAll("span")).filter((s) => /^de\s\d/.test((s.textContent ?? "").trim()));
      // The outermost: the note box itself, not an inline span inside it.
      const note = spans.find((s) => !spans.some((o) => o !== s && o.contains(s)));
      if (!note) continue;
      const style = getComputedStyle(note);
      const lineHeight = Number.isNaN(parseFloat(style.lineHeight)) ? parseFloat(style.fontSize) * 1.2 : parseFloat(style.lineHeight);
      const box = note.getBoundingClientRect();
      const text = (li.textContent ?? "").toLowerCase();
      const month = names.find((n) => text.includes(n)) ?? "";
      // The month's cell: its first span. A note dropped under it starts below its bottom edge.
      const cell = li.querySelector("a > span:first-child")?.getBoundingClientRect() ?? null;
      out.push({
        text: (note.textContent ?? "").trim(),
        month,
        lines: box.height / lineHeight,
        noteRight: box.right - row.right,
        chevronRight: (() => {
          const chevron = li.querySelector("svg")?.getBoundingClientRect();
          return chevron ? chevron.right - row.right : null;
        })(),
        rowRight: row.right,
        sameLineAsMonth: cell ? box.top < cell.bottom - 1 && box.bottom > cell.top + 1 : false,
      });
    }
    return out;
  }, MONTH_NAMES);
}

async function openMonths(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  sessionFile: string,
  goalId: string,
  width: number,
) {
  const context = await browser.newContext({ storageState: sessionFile, baseURL });
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/metas/${goalId}/meses`);
  await expect(page.locator("main ol > li").first()).toBeVisible();
  return { context, page };
}

for (const width of [360, 1024, 1280, 1440]) {
  test(`at ${width}px a long time note («de 8 h 03 min») is one line and neither it nor the chevron leaves its row (843, RP-32)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const { month, day, share } = openingForLongShare(600);
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
      values (${person.id}, ${`Guitarra ${width} ${Date.now()}`}, ${thisMonth}::date + 120, 'práctica', 'minutos', 600,
        (${month}::date + ${day - 1}::int) + time '12:00' at time zone 'UTC')
      returning id
    `;
    // Reached time beside the note is what squeezes it.
    const [done] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goal.id}, 'Hecha', ${month}::date, 90) returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${goal.id}, ${done.id}, ${month}::date + ${day - 1}::int)
    `;
    const { context, page } = await openMonths(browser, baseURL!, person.sessionFile, goal.id, width);
    try {
      const notes = await measureNotes(page);
      const long = notes.filter((n) => n.text.replace(/\s+/g, " ") === `de ${timeWords(share)}`);
      expect(long.length, `a row says «de ${timeWords(share)}»; saw ${JSON.stringify(notes.map((n) => n.text))}`).toBe(1);
      for (const n of notes) {
        expect.soft(n.lines, `${n.month} «${n.text}» lines`).toBeLessThan(1.5);
        expect.soft(n.noteRight, `${n.month} «${n.text}» note past row`).toBeLessThanOrEqual(0.5);
        expect(n.chevronRight, `${n.month} chevron present`).not.toBeNull();
        expect.soft(n.chevronRight!, `${n.month} «${n.text}» chevron past row`).toBeLessThanOrEqual(0.5);
      }
      if (width === 360) {
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), "page scroll width").toBeLessThanOrEqual(360);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goal.id}`;
    }
  });
}

for (const width of [360, 1024, 1280, 1440]) {
  test(`at ${width}px Reto's two partial months keep one line each and the chevrons in their rows (843, RP-76)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
      values (${person.id}, ${`Reto ${width} ${Date.now()}`}, (${thisMonth}::date + 7), 'lectura', 'minutos', 600,
        (${lastMonth}::date + 15) + time '12:00' at time zone 'UTC')
      returning id
    `;
    const { context, page } = await openMonths(browser, baseURL!, person.sessionFile, goal.id, width);
    try {
      const notes = await measureNotes(page);
      expect(notes.length).toBe(2);
      for (const n of notes) {
        expect.soft(n.lines, `${n.month} «${n.text}» lines`).toBeLessThan(1.5);
        expect.soft(n.noteRight, `${n.month} «${n.text}» note past row`).toBeLessThanOrEqual(0.5);
        expect.soft(n.chevronRight!, `${n.month} «${n.text}» chevron past row`).toBeLessThanOrEqual(0.5);
      }
      if (width === 360) {
        expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), "page scroll width").toBeLessThanOrEqual(360);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goal.id}`;
    }
  });
}

test("at 1440px a short note («de 10 h», a whole month) stays on the month's line (843)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${`Entera ${Date.now()}`}, ${thisMonth}::date + 120, 'práctica', 'minutos', 600,
      ${lastMonth}::date + time '12:00' at time zone 'UTC')
    returning id
  `;
  const { context, page } = await openMonths(browser, baseURL!, person.sessionFile, goal.id, 1440);
  try {
    const notes = await measureNotes(page);
    const whole = notes.filter((n) => /^de\s10\sh$/.test(n.text));
    expect(whole.length, `rows saying «de 10 h»: ${JSON.stringify(notes.map((n) => n.text))}`).toBeGreaterThanOrEqual(2);
    for (const n of whole) {
      expect(n.sameLineAsMonth, `${n.month}: «${n.text}» on the month's line`).toBe(true);
      expect(n.lines).toBeLessThan(1.5);
    }
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});
