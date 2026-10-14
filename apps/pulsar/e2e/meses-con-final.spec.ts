import { test, expect } from "./fixtures";
import { dayBefore } from "./meta-arbol-seed";
import { MINUTES, PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf, shift, TODAY } from "./sin-final-seed";
import {
  OWN,
  AND_OWN,
  budget,
  expectInOrder,
  keysFor,
  mainLower,
  monthKey,
  monthName,
  monthTargets,
  open,
  openedIn,
  paperOf,
  range,
  reportRow,
  rowLink,
  rowMonths,
  sectionOf,
  seeAll,
  textOf,
  yOf,
} from "./mes-siguiente-seed";
import { civilDateToDate } from "@/lib/zone";

import type { Locator, Page } from "@playwright/test";
import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Module 947, RP-115 (module 953, RP-116: the line is text, «ver todo» sits under it, the line follows the months of an amount of their own): a goal with an end of more than 12 rows folds «Por mes», the report and paper as one with no end does:
// the last 11 closed months, the current one, next month, then «N meses más, hasta el {último día}» (no amount: the last month is
// partial), the months set by hand under «y estos meses con monto propio:», and «ver todo». A goal with 12 rows or fewer reads as
// before. Every «N MESES» equals the month rows drawn, own-amount rows included, on screen and on paper.
// Contract: private/contrato-947.md (E1–E8); boards PorMesConFinal, CuentaMeses. Every month is an offset from the current month
// and every end is built from it, so a spec runs on any day. Each test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
// «3 ene 2027»: how the line names the goal's last day.
const wordsOf = (day: string) => `${Number(day.slice(8, 10))} ${ABBR[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const weekday = (day: string) => civilDateToDate(day).getUTCDay();

// The Monday on or after the 2nd of the month `offset` away: its eve, a Sunday, is the last day and falls in that month.
function horizonIn(offset: number): string {
  let day = shift(monthStartOf(offset), 1);
  while (weekday(day) !== 1) day = shift(day, 1);
  return day;
}
const lastDayIn = (offset: number) => dayBefore(horizonIn(offset));

const lineRe = (count: number, offset: number) => new RegExp(`${count} meses más, hasta el ${wordsOf(lastDayIn(offset))}`, "i");
const lineText = (count: number, offset: number) => `${count} meses más, hasta el ${wordsOf(lastDayIn(offset))}`;
// RP-116: the line is text, never a link: «ver todo» is what opens the whole list.
const lineOf = (scope: Page | Locator, count: number, offset: number) => scope.getByText(lineRe(count, offset)).locator("visible=true");
const lineAsLink = (scope: Page | Locator, count: number, offset: number) =>
  scope.getByRole("link", { name: lineRe(count, offset), includeHidden: true });
// «13 meses» but not the «2 meses más» of the line.
const captionRe = (count: number) => new RegExp(`(?<!\\d)${count} meses(?! más)`);
// RP-118: a goal with an end whose list folds says «{drawn} de {the goal's months} meses».
const ofRe = (shown: number, total: number) => new RegExp(`(?<!\\d)${shown} de ${total} meses(?! más)`);

async function seedLeer(
  db: Db,
  person: Person,
  o: { endsIn: number | null; name?: string; rhythm?: number | null; opened?: number },
) {
  return seedOpenGoal(db, person, {
    name: o.name ?? "Leer",
    unit: PAGES,
    horizon: o.endsIn === null ? null : horizonIn(o.endsIn),
    rhythm: o.rhythm === undefined ? 40 : o.rhythm,
    created: openedIn(o.opened ?? -23),
  });
}

for (const width of [360, 1280]) {
  test.describe(`«Por mes» of a goal with an end, at ${width}`, () => {
    test("E2: 11 closed, the current month, next month 40, then «2 meses más, hasta el …» as text, «ver todo»; 13 MESES (RP-115, RP-116)", async ({ person, browser, baseURL, db }) => {
      // Kills: the cut only when `horizon === null` (the rule of s4); the line missing or wrong; the count of the rows drawn; the line as a `TextLink`.
      const id = await seedLeer(db, person, { endsIn: 3 });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 1)));
        expect(await mainLower(page)).toMatch(ofRe(13, 27));
        await expect(rowLink(page, id, 0)).toContainText("en curso");
        const next = rowLink(page, id, 1);
        await expect(next).toContainText("planeado");
        await expect(next).toContainText("40");
        const line = lineOf(main, 2, 3);
        await expect(line).toBeVisible();
        await expect(lineAsLink(main, 2, 3)).toHaveCount(0);
        await expect(seeAll(main)).toBeVisible();
        expect((await seeAll(main).getAttribute("href")) ?? "").toContain("todo=1");
        const lower = await mainLower(page);
        expect(lower).not.toContain("cada uno");
        expect(lower).not.toContain("monto propio");
        const [n, l, s] = [await yOf(next), await yOf(line), await yOf(seeAll(main))];
        expect(l.top, "the line under next month").toBeGreaterThanOrEqual(n.bottom - 1);
        expect(s.top, "«ver todo» under the line").toBeGreaterThanOrEqual(l.bottom - 1);
      } finally {
        await context.close();
      }
    });

    test("E2b: with a month set by hand the label comes first, then its month, then the line of the rest, then «ver todo»; 14 MESES (RP-115, RP-116)", async ({ person, browser, baseURL, db }) => {
      // Kills: `handSet` kept in the first table; the cut without `ends`; the last (partial) month taken for an amount of its own; the line in the `after` of the first table.
      const id = await seedLeer(db, person, { endsIn: 9 });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 2)));
        expect(await mainLower(page)).toMatch(ofRe(14, 33));
        const line = lineOf(main, 7, 9);
        const label = textOf(main, OWN);
        await expect(line).toBeVisible();
        await expect(lineAsLink(main, 7, 9)).toHaveCount(0);
        await expect(label).toBeVisible();
        await expect(textOf(main, AND_OWN)).toHaveCount(0);
        await expect(rowLink(page, id, 2)).toContainText("60");
        await expect(rowLink(page, id, 2)).toContainText("planeado");
        const [n, r, o, l] = [await yOf(rowLink(page, id, 1)), await yOf(label), await yOf(rowLink(page, id, 2)), await yOf(line)];
        expect(r.top, "the label under next month").toBeGreaterThanOrEqual(n.bottom - 1);
        expect(o.top, "the month of its own amount under the label").toBeGreaterThanOrEqual(r.bottom - 1);
        expect(l.top, "the line after the months of an amount of their own").toBeGreaterThanOrEqual(o.bottom - 1);
        expect((await yOf(seeAll(main))).top, "«ver todo» under the line").toBeGreaterThanOrEqual(l.bottom - 1);
        const first = rowLink(page, id, 1).first().locator("xpath=ancestor::*[self::table or self::ol][1]");
        await expect(first.locator("a", { hasText: new RegExp(monthLabel(2), "i") })).toHaveCount(0);
        await expect(seeAll(main)).toBeVisible();
      } finally {
        await context.close();
      }
    });
  });
}

test("E2: next month's row opens the amount sheet, `?planear=` and «¿Cuánto en …?» (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: `sheetFor` only for a goal with no end; the cut handing no `next` to a goal with an end.
  const id = await seedLeer(db, person, { endsIn: 3 });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    const href = (await rowLink(page, id, 1).first().getAttribute("href")) ?? "";
    expect(href).toContain(`planear=${monthKey(1)}`);
    await rowLink(page, id, 1).first().click();
    await expect(page).toHaveURL(new RegExp(`planear=${monthKey(1)}`));
    await expect(page.getByRole("dialog").getByRole("heading", { name: `¿Cuánto en ${monthName(1)}?` })).toBeVisible();
    // Every other row leads to its page.
    const targets = await monthTargets(page, id);
    expect(targets[monthKey(0)]).toEqual([`/metas/${id}/meses/${monthKey(0)}`]);
  } finally {
    await context.close();
  }
});

test("E2c: `?todo=1` lists the 27 months in order, with no line and no label; the last one reads «planeado» with its part (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: the line or the rótulo drawn with `all`; the count of the folded list on the whole one.
  const id = await seedLeer(db, person, { endsIn: 3 });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, 360);
  try {
    const targets = await monthTargets(page, id);
    expect(Object.keys(targets).sort()).toEqual(keysFor(range(-23, 3)));
    for (const offset of range(-23, 3)) expect(targets[monthKey(offset)], monthLabel(offset)).toEqual([`/metas/${id}/meses/${monthKey(offset)}`]);
    const lower = await mainLower(page);
    expect(lower).toMatch(captionRe(27));
    expect(lower).not.toMatch(/meses más|monto propio/);
    await expect(seeAll(page.locator("main"))).toHaveCount(0);
    const day = Number(lastDayIn(3).slice(8, 10));
    const days = new Date(Date.UTC(Number(monthStartOf(3).slice(0, 4)), Number(monthStartOf(3).slice(5, 7)), 0)).getUTCDate();
    const part = Math.floor((40 * day) / days);
    expect((await rowLink(page, id, 3).first().innerText()).replace(/\s+/g, " ")).toMatch(new RegExp(`planeado\\D*${part}(?!\\d)`, "i"));
  } finally {
    await context.close();
  }
});

test("E7: ten years: 2 MESES, «118 meses más, hasta el …», and «ver todo» though no closed month is hidden; `?todo=1` lists 120 (RP-115, RP-116)", async ({ person, browser, baseURL, db }) => {
  // Kills: folding only the closed months; `seeAll` = `hidden > 0`.
  const id = await seedOpenGoal(db, person, {
    name: "Piano",
    unit: MINUTES,
    horizon: horizonIn(119),
    rhythm: 600,
    created: openedOnDay(1).at,
  });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    expect(await rowMonths(page, id)).toEqual(keysFor([0, 1]));
    expect(await mainLower(page)).toMatch(ofRe(2, 120));
    await expect(lineOf(page.locator("main"), 118, 119)).toBeVisible();
    await expect(lineAsLink(page.locator("main"), 118, 119)).toHaveCount(0);
    await expect(seeAll(page.locator("main"))).toBeVisible();
    expect((await seeAll(page.locator("main")).getAttribute("href")) ?? "").toContain("todo=1");
    await rowLink(page, id, 1).first().click();
    await expect(page).toHaveURL(new RegExp(`planear=${monthKey(1)}`));
    await page.goto(`/metas/${id}/meses?todo=1`);
    await expect(page.locator("main a[href*='/meses/']").first()).toBeVisible();
    expect(await rowMonths(page, id)).toHaveLength(120);
  } finally {
    await context.close();
  }
});

test("E8: the end falls this month: the current month, no next month, no line (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: a `rest` of 0 drawn as a line; a next month beyond the end.
  const id = await seedOpenGoal(db, person, {
    name: "Corta",
    unit: PAGES,
    horizon: monthStartOf(1),
    rhythm: 40,
    created: openedIn(-13),
  });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 0)));
    await expect(rowLink(page, id, 0)).toContainText("en curso");
    const lower = await mainLower(page);
    expect(lower).toMatch(ofRe(12, 14));
    expect(lower).not.toMatch(/meses más|mes más/);
    await expect(seeAll(page.locator("main"))).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E3: an end of 3 months reads as before: 3 rows, each to its page, no line, no «ver todo» (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: `foldsMonths` true for every goal with an end; `?planear=` on a goal that does not fold.
  const id = await seedOpenGoal(db, person, { name: "Correr", unit: PAGES, horizon: horizonIn(2), rhythm: 40, created: openedOnDay(1).at });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    const targets = await monthTargets(page, id);
    expect(Object.keys(targets).sort()).toEqual(keysFor([0, 1, 2]));
    for (const [month, hrefs] of Object.entries(targets)) expect(hrefs, month).toEqual([`/metas/${id}/meses/${month}`]);
    const lower = await mainLower(page);
    expect(lower).toMatch(captionRe(3));
    expect(lower).not.toMatch(/meses más|monto propio|cada uno/);
    await expect(seeAll(page.locator("main"))).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("E4: with an end and no rhythm: the months from September, «sin monto» ahead, 4 rows as before (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: `foldsMonths` true for every goal with an end.
  const id = await seedOpenGoal(db, person, { name: "Inglés", unit: MINUTES, horizon: horizonIn(2), rhythm: null, created: openedIn(-1) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    expect(await rowMonths(page, id)).toEqual(keysFor(range(-1, 2)));
    await expect(rowLink(page, id, 0)).toContainText("en curso");
    for (const offset of [1, 2]) await expect(rowLink(page, id, offset).first()).toContainText("sin monto");
    const lower = await mainLower(page);
    expect(lower).toMatch(captionRe(4));
    expect(lower).not.toMatch(/meses más|monto propio/);
    await expect(seeAll(page.locator("main"))).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("E5: an ended goal of 20 months: 12 MESES, «ver todo», every row to its page and none to the amount sheet (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: the cut that leaves a goal with an end whole; a sheet link on an ended goal.
  let horizon = TODAY;
  while (weekday(horizon) !== 1) horizon = shift(horizon, -1);
  const last = dayBefore(horizon).slice(0, 7) === monthKey(0) ? 0 : -1;
  const id = await seedOpenGoal(db, person, { name: "Pintar", unit: PAGES, horizon, rhythm: 40, created: openedIn(last - 19) });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    const targets = await monthTargets(page, id);
    expect(Object.keys(targets).sort()).toEqual(keysFor(range(last - 11, last)));
    for (const [month, hrefs] of Object.entries(targets)) expect(hrefs, month).toEqual([`/metas/${id}/meses/${month}`]);
    expect(await mainLower(page)).toMatch(ofRe(12, 20));
    await expect(page.locator(`main a[href*="planear="]`)).toHaveCount(0);
    await expect(rowLink(page, id, last)).not.toContainText("en curso");
    await expect(seeAll(page.locator("main"))).toBeVisible();
    expect(await mainLower(page)).not.toMatch(/meses más/);
  } finally {
    await context.close();
  }
});

test("E6: an archived goal with no end: next month leads to its page, never to the amount sheet (RP-110, RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: `archivedAt === null` dropped from `sheetFor` (s4 survivor M3).
  const id = await seedLeer(db, person, { endsIn: null, rhythm: null, opened: -2, name: "Ahorrar" });
  await db`update goals.goals set archived_at = now() where id = ${id}`;
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    const targets = await monthTargets(page, id);
    expect(Object.keys(targets).sort()).toEqual(keysFor([-2, -1, 0, 1]));
    expect(targets[monthKey(1)]).toEqual([`/metas/${id}/meses/${monthKey(1)}`]);
    await expect(rowLink(page, id, 1).first()).toContainText("sin monto");
    await expect(page.locator(`main a[href*="planear="]`)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ---- The count of the rows drawn (E1) -----------------------------------------------------------------------------------

test("E1: «Por mes» of a goal with no end says 14 MESES over 14 rows with a month set by hand, 13 without it, 35 with `?todo=1` (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: counting without the months of an amount of their own (b3442d67).
  const withOwn = await seedLeer(db, person, { endsIn: null });
  await budget(db, person, withOwn, 2, 60);
  const without = await seedLeer(db, person, { endsIn: null, name: "Sin propio" });
  const a = await open(browser, baseURL, person.sessionFile, `/metas/${withOwn}/meses`, 360);
  try {
    expect(await rowMonths(a.page, withOwn)).toHaveLength(14);
    expect(await mainLower(a.page)).toMatch(captionRe(14));
    await a.page.goto(`/metas/${withOwn}/meses?todo=1`);
    await expect(rowLink(a.page, withOwn, 2).first()).toBeVisible();
    expect(await mainLower(a.page)).toMatch(captionRe(35));
  } finally {
    await a.context.close();
  }
  const b = await open(browser, baseURL, person.sessionFile, `/metas/${without}/meses`, 360);
  try {
    expect(await rowMonths(b.page, without)).toHaveLength(13);
    expect(await mainLower(b.page)).toMatch(captionRe(13));
  } finally {
    await b.context.close();
  }
});

for (const width of [360, 1280]) {
  test(`E1: the report at ${width} says 14 MESES over its two tables; 35 with \`?todo=1\` (RP-115)`, async ({ person, browser, baseURL, db }) => {
    // Kills: the screen caption counting `first.length` (b3442d67); the whole list not counting its rows.
    const id = await seedLeer(db, person, { endsIn: null });
    await budget(db, person, id, 2, 60);
    const a = await open(browser, baseURL, person.sessionFile, "/exportar", width);
    try {
      await expect(a.page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
      const section = sectionOf(a.page, "Leer");
      for (const offset of range(-11, 2)) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(1);
      expect((await section.innerText()).toLowerCase()).toMatch(captionRe(14));
    } finally {
      await a.context.close();
    }
    const b = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
    try {
      await expect(b.page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
      expect((await sectionOf(b.page, "Leer").innerText()).toLowerCase()).toMatch(captionRe(35));
    } finally {
      await b.context.close();
    }
  });

  test(`E2d: the report at ${width} of a goal with an end: the same order as «Por mes», the line is text and «ver todo» opens \`/exportar?todo=1\`; 13 MESES (RP-115, RP-116)`, async ({ person, browser, baseURL, db }) => {
    // Kills: the cut only in «Por mes»; «ver todo» to anywhere but the whole report; `screenAhead` as a `TextLink`.
    const id = await seedLeer(db, person, { endsIn: 3 });
    const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
    try {
      await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
      const section = sectionOf(page, "Leer");
      for (const offset of range(-11, 1)) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(1);
      for (const offset of [-12, 2, 3]) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(0);
      await expect(reportRow(section, 0)).toContainText("en curso");
      await expect(reportRow(section, 1)).toContainText("40");
      // The wide face says «planeado» once, in the header.
      if (width < 700) await expect(reportRow(section, 1)).toContainText("planeado");
      const line = lineOf(section, 2, 3);
      await expect(line).toBeVisible();
      await expect(lineAsLink(section, 2, 3)).toHaveCount(0);
      await expect(seeAll(section)).toBeVisible();
      const href = (await seeAll(section).getAttribute("href")) ?? "";
      expect(href).toContain("/exportar");
      expect(href).toContain("todo=1");
      const text = (await section.innerText()).toLowerCase();
      expect(text).toMatch(ofRe(13, 27));
      expect(text).not.toContain("cada uno");
      const [n, l, s] = [await yOf(reportRow(section, 1)), await yOf(line), await yOf(seeAll(section))];
      expect(l.top).toBeGreaterThanOrEqual(n.bottom - 1);
      expect(s.top).toBeGreaterThanOrEqual(l.bottom - 1);
      expect(id).toBeTruthy();
    } finally {
      await context.close();
    }
  });
}

test("E2d: the report with an end and a month set by hand: the label, the second table with 60, the line, «ver todo»; 14 MESES (RP-115, RP-116)", async ({ person, browser, baseURL, db }) => {
  // Kills: the own-amount table missing on a goal with an end; the last month in it; the line before the second table.
  const id = await seedLeer(db, person, { endsIn: 9 });
  await budget(db, person, id, 2, 60);
  const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", 1280);
  try {
    await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
    const section = sectionOf(page, "Leer");
    for (const offset of range(-11, 2)) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(1);
    await expect(reportRow(section, 9)).toHaveCount(0);
    await expect(reportRow(section, 2)).toContainText("60");
    await expect(lineAsLink(section, 7, 9)).toHaveCount(0);
    await expect(textOf(section, AND_OWN)).toHaveCount(0);
    const [n, r, o, l, s] = [
      await yOf(reportRow(section, 1)),
      await yOf(textOf(section, OWN)),
      await yOf(reportRow(section, 2)),
      await yOf(lineOf(section, 7, 9)),
      await yOf(seeAll(section)),
    ];
    expect(r.top, "the label under next month").toBeGreaterThanOrEqual(n.bottom - 1);
    expect(o.top, "the own-amount month under the label").toBeGreaterThanOrEqual(r.bottom - 1);
    expect(l.top, "the line after the own-amount months").toBeGreaterThanOrEqual(o.bottom - 1);
    expect(s.top, "«ver todo» under the line").toBeGreaterThanOrEqual(l.bottom - 1);
    expect((await section.innerText()).toLowerCase()).toMatch(ofRe(14, 33));
  } finally {
    await context.close();
  }
});

// ---- Paper ---------------------------------------------------------------------------------------------------------

for (const query of ["", "?todo=1"]) {
  test(`E2d on paper (/exportar${query}): LEER · POR MES · 13 MESES, 12 months, next month, «2 meses más, hasta el …»; nothing else (RP-115)`, async ({ person, browser, baseURL, db }) => {
    // Kills: printing the whole stretch; repeating the rest in a «…: sin monto»; the paper changing with `?todo=1`.
    await seedLeer(db, person, { endsIn: 3 });
    const paper = await paperOf(browser, baseURL, person.sessionFile, `/exportar${query}`, "Leer");
    expect(paper).toContain("leer · por mes · 13 de 27 meses");
    expectInOrder(paper, [monthLabel(-11), monthLabel(0), monthLabel(1), lineText(2, 3)]);
    for (const offset of [-12, 2, 3]) expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
    expect(paper).not.toContain(": sin monto");
    expect(paper).not.toContain("cada uno");
    expect(paper).not.toContain("ver todo");
  });
}

test("E2b on paper: 14 MESES, the label, the month set by hand, then the line of 7; the last month is no row (RP-115, RP-116)", async ({ person, browser, baseURL, db }) => {
  // Kills: counting the screen's rows on paper; the last month in the second table; `rest` repeated; `paperAhead` in the `after` of the first table.
  const id = await seedLeer(db, person, { endsIn: 9 });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 14 de 33 meses");
  expectInOrder(paper, [monthLabel(-11), monthLabel(0), monthLabel(1), "estos meses con monto propio:", monthLabel(2), lineText(7, 9)]);
  expect(paper).not.toContain("y estos meses con monto propio");
  expect(paper).not.toContain(monthLabel(9));
  expect(paper).not.toContain(": sin monto");
});

test("E1 on paper: 14 meses with a month set by hand, the same with `?todo=1` of the screen (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: counting `paperMonths` on screen with `?todo=1`, or the screen's rows on paper.
  const id = await seedLeer(db, person, { endsIn: null });
  await budget(db, person, id, 2, 60);
  for (const query of ["", "?todo=1"]) {
    const paper = await paperOf(browser, baseURL, person.sessionFile, `/exportar${query}`, "Leer");
    expect(paper, query).toContain("leer · por mes · 14 meses");
  }
});

// ---- 360 -----------------------------------------------------------------------------------------------------------------

test("at 360 «Por mes» and the report of a goal with an end fit with the line, the label, the second table and «ver todo» (RP-115)", async ({ person, browser, baseURL, db }) => {
  // Kills: a line wider than the column, pushing the page sideways.
  const id = await seedLeer(db, person, { endsIn: 9, name: "Leer largo para medir el ancho de la línea y del rótulo" });
  await budget(db, person, id, 2, 60);
  for (const path of [`/metas/${id}/meses`, "/exportar"]) {
    const { page, context } = await open(browser, baseURL, person.sessionFile, path, 360);
    try {
      const scope = page.locator("main");
      const pieces = [lineOf(scope, 7, 9).first(), textOf(scope, OWN).first(), seeAll(scope).first()];
      for (const piece of pieces) await expect(piece, path).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, path).toBeLessThanOrEqual(0);
      for (const piece of pieces) {
        const box = await piece.boundingBox();
        expect(box, path).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      }
    } finally {
      await context.close();
    }
  }
});
