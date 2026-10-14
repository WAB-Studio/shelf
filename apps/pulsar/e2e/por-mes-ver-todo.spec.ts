import { test, expect } from "./fixtures";
import { dayBefore } from "./meta-arbol-seed";
import { PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf, shift } from "./sin-final-seed";
import {
  AND_OWN,
  OWN,
  budget,
  expectInOrder,
  keysFor,
  lineLink,
  mainLower,
  monthKey,
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

// Module 953, RP-116: a goal with an end reads its months in time order. After the first table come the label «estos meses con
// monto propio:» (no «y»), the months set by hand, THEN the line «N meses más, hasta el {último día}», as text, and «ver todo»
// under it whenever the line or a hidden closed month exists. A goal with no end reads as before (C1). `?todo=1` draws neither
// line, label nor «ver todo» (V7) and never on a goal with no unit (V6, r5). Boards PorMesConFinalVerTodo.
// Contract: private/953-contrato.md (V1–V7, C1). V1, V2, V4 live in `meses-con-final.spec.ts` (inverted there); C2–C4 are E3, E8, E5 there.
// Every month is an offset from the current month and every end is built from it, so a spec runs on any day.

test.use({ actionTimeout: 6000 });

const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const wordsOf = (day: string) => `${Number(day.slice(8, 10))} ${ABBR[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const weekday = (day: string) => civilDateToDate(day).getUTCDay();

// The Monday on or after the 2nd of the month `offset` away: its eve, a Sunday, is the last day and falls in that month.
function horizonIn(offset: number): string {
  let day = shift(monthStartOf(offset), 1);
  while (weekday(day) !== 1) day = shift(day, 1);
  return day;
}
const lastDayIn = (offset: number) => dayBefore(horizonIn(offset));

const lineWords = (count: number, offset: number) => `${count} ${count === 1 ? "mes" : "meses"} más, hasta el ${wordsOf(lastDayIn(offset))}`;
const lineRe = (count: number, offset: number) => new RegExp(lineWords(count, offset), "i");
const lineOf = (scope: Page | Locator, count: number, offset: number) => scope.getByText(lineRe(count, offset)).locator("visible=true");
const lineAsLink = (scope: Page | Locator, count: number, offset: number) =>
  scope.getByRole("link", { name: lineRe(count, offset), includeHidden: true });
const captionRe = (count: number) => new RegExp(`(?<!\\d)${count} meses(?! más)`);
// RP-118: a goal with an end whose list folds says «{drawn} de {the goal's months} meses».
const ofRe = (shown: number, total: number) => new RegExp(`(?<!\\d)${shown} de ${total} meses(?! más)`);

async function seedLeer(db: Db, person: Person, o: { endsIn: number | null; name?: string; rhythm?: number | null; opened?: number }) {
  return seedOpenGoal(db, person, {
    name: o.name ?? "Leer",
    unit: PAGES,
    horizon: o.endsIn === null ? null : horizonIn(o.endsIn),
    rhythm: o.rhythm === undefined ? 40 : o.rhythm,
    created: openedIn(o.opened ?? -23),
  });
}

// V5: no unit, an end 14 months ahead (15 rows), one task in next month.
async function seedMudanza(db: Db, person: Person) {
  const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: null, horizon: horizonIn(14), rhythm: null, created: openedOnDay(1).at });
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${id}, ${"Empacar"}, ${monthStartOf(1)}::date)`;
  return id;
}

for (const width of [360, 1280]) {
  test.describe(`RP-116 at ${width}`, () => {
    test("V3: one month left out reads «1 mes más, hasta el …» after the month set by hand, as text, then «ver todo»; 14 MESES", async ({ person, browser, baseURL, db }) => {
      // Kills: `restCount > 1` (u5); the line in the `after` of the first table; the line as a link.
      const id = await seedLeer(db, person, { endsIn: 3 });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 2)));
        expect(await mainLower(page)).toMatch(ofRe(14, 27));
        const line = lineOf(main, 1, 3);
        await expect(line).toBeVisible();
        await expect(lineAsLink(main, 1, 3)).toHaveCount(0);
        await expect(textOf(main, OWN)).toBeVisible();
        const [own, l, s] = [await yOf(rowLink(page, id, 2)), await yOf(line), await yOf(seeAll(main))];
        expect(l.top, "the line after the month set by hand").toBeGreaterThanOrEqual(own.bottom - 1);
        expect(s.top, "«ver todo» under the line").toBeGreaterThanOrEqual(l.bottom - 1);
        expect((await seeAll(main).getAttribute("href")) ?? "").toContain("todo=1");
      } finally {
        await context.close();
      }
    });

    test("V3 in the report: «1 mes más, hasta el …» as text after the second table, then «ver todo» to `/exportar?todo=1`", async ({ person, browser, baseURL, db }) => {
      // Kills: `restCount > 1` (u5) on the report; `screenAhead` before the second table or as a `TextLink`.
      const id = await seedLeer(db, person, { endsIn: 3 });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, "Leer");
        expect((await section.innerText()).toLowerCase()).toMatch(ofRe(14, 27));
        const line = lineOf(section, 1, 3);
        await expect(line).toBeVisible();
        await expect(lineAsLink(section, 1, 3)).toHaveCount(0);
        const [own, l, s] = [await yOf(reportRow(section, 2)), await yOf(line), await yOf(seeAll(section))];
        expect(l.top, "the line after the month set by hand").toBeGreaterThanOrEqual(own.bottom - 1);
        expect(s.top, "«ver todo» under the line").toBeGreaterThanOrEqual(l.bottom - 1);
        const href = (await seeAll(section).getAttribute("href")) ?? "";
        expect(href).toContain("/exportar");
        expect(href).toContain("todo=1");
      } finally {
        await context.close();
      }
    });

    test("an end with no rhythm and nothing set by hand: the first table, the line as text and «ver todo» (empty state)", async ({ person, browser, baseURL, db }) => {
      // Kills: «ver todo» only with something hidden; the line only with a rhythm.
      const id = await seedLeer(db, person, { endsIn: 3, rhythm: null });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 1)));
        await expect(lineOf(main, 2, 3)).toBeVisible();
        await expect(lineAsLink(main, 2, 3)).toHaveCount(0);
        await expect(seeAll(main)).toBeVisible();
        expect(await mainLower(page)).not.toContain("monto propio");
      } finally {
        await context.close();
      }
    });

    test("V5: a goal with no unit and an end folds «Por mes» to 2 rows, «13 meses más, hasta el …» as text, «ver todo»", async ({ person, browser, baseURL, db }) => {
      // Kills: the table with no unit drawn with no line (b50f3fea); the line as a link; «ver todo» missing with nothing closed hidden.
      const id = await seedMudanza(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        expect(await rowMonths(page, id)).toEqual(keysFor([0, 1]));
        expect(await mainLower(page)).toMatch(ofRe(2, 15));
        await expect(rowLink(page, id, 0)).toContainText("en curso");
        await expect(rowLink(page, id, 0)).toContainText("sin tareas");
        await expect(rowLink(page, id, 1)).toContainText("1 tarea");
        const line = lineOf(main, 13, 14);
        await expect(line).toBeVisible();
        await expect(lineAsLink(main, 13, 14)).toHaveCount(0);
        await expect(seeAll(main)).toBeVisible();
        expect((await seeAll(main).getAttribute("href")) ?? "").toContain("todo=1");
        const [n, l, s] = [await yOf(rowLink(page, id, 1)), await yOf(line), await yOf(seeAll(main))];
        expect(l.top, "the line under next month").toBeGreaterThanOrEqual(n.bottom - 1);
        expect(s.top, "«ver todo» under the line").toBeGreaterThanOrEqual(l.bottom - 1);
      } finally {
        await context.close();
      }
    });

    test("V5 in the report: a goal with no unit has no months on screen (paper only) and its line is never a link, hidden or not", async ({ person, browser, baseURL, db }) => {
      // Kills: `restLine` kept as a `TextLink` in the table with no unit (b50f3fea): that table is `PrintBlock only`, so the link is in the DOM and never on screen.
      await seedMudanza(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText("Mudanza", { exact: true }).first()).toBeVisible();
        const main = page.locator("main");
        await expect(lineAsLink(main, 13, 14)).toHaveCount(0);
        await expect(main.getByRole("link", { name: /mes(es)? más, hasta el/, includeHidden: true })).toHaveCount(0);
        await expect(main.getByText("sin tareas")).toBeHidden();
        await expect(seeAll(main)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("V6 (r5): `/exportar?todo=1` of a goal with no unit holds no «meses más» link (its paper keeps the line: the PDF test below)", async ({ person, browser, baseURL, db }) => {
      // Kills: `restLine ?` without `!all` in the table with no unit (r5.patch): it puts the link back into the DOM of the whole list.
      await seedMudanza(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(page.getByRole("main").getByText("Mudanza", { exact: true }).first()).toBeVisible();
        const main = page.locator("main");
        await expect(main.getByRole("link", { name: /mes(es)? más, hasta el/, includeHidden: true })).toHaveCount(0);
        await expect(seeAll(main)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("V7: `?todo=1` of V2 lists every month with no line, no label and no «ver todo» in «Por mes» and the report", async ({ person, browser, baseURL, db }) => {
      // Kills: the line, the label or «ver todo» drawn with `all`.
      const id = await seedLeer(db, person, { endsIn: 9 });
      await budget(db, person, id, 2, 60);
      const a = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        const targets = await monthTargets(a.page, id);
        expect(Object.keys(targets).sort()).toEqual(keysFor(range(-23, 9)));
        const lower = await mainLower(a.page);
        expect(lower).toMatch(captionRe(33));
        expect(lower).not.toMatch(/mes(es)? más|monto propio/);
        await expect(seeAll(a.page.locator("main"))).toHaveCount(0);
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(b.page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
        const section = sectionOf(b.page, "Leer");
        for (const offset of range(-23, 9)) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(1);
        const text = (await section.innerText()).toLowerCase();
        expect(text).toMatch(captionRe(33));
        expect(text).not.toMatch(/mes(es)? más|monto propio/);
        await expect(seeAll(section)).toHaveCount(0);
      } finally {
        await b.context.close();
      }
    });

    test("C1: a goal with no end keeps its rhythm line as a link before «y estos meses con monto propio:», then «ver todo»", async ({ person, browser, baseURL, db }) => {
      // Kills: moving the rhythm line after the label too; the rhythm line as text; «y» cut from the label of a goal with no end.
      const id = await seedLeer(db, person, { endsIn: null });
      await budget(db, person, id, 2, 60);
      const a = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = a.page.locator("main");
        const ahead = lineLink(main);
        await expect(ahead).toBeVisible();
        expect((await ahead.getAttribute("href")) ?? "").toContain("todo=1");
        await expect(textOf(main, AND_OWN)).toBeVisible();
        await expect(textOf(main, OWN)).toHaveCount(0);
        const [l, r, o] = [await yOf(ahead), await yOf(textOf(main, AND_OWN)), await yOf(rowLink(a.page, id, 2))];
        expect(r.top, "the label after the rhythm line").toBeGreaterThanOrEqual(l.bottom - 1);
        expect(o.top, "the month set by hand after the label").toBeGreaterThanOrEqual(r.bottom - 1);
        await expect(rowLink(a.page, id, 2)).toContainText("60");
        await expect(seeAll(main)).toBeVisible();
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(b.page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
        const section = sectionOf(b.page, "Leer");
        const ahead = lineLink(section);
        await expect(ahead).toBeVisible();
        const [l, r, o] = [await yOf(ahead), await yOf(textOf(section, AND_OWN)), await yOf(reportRow(section, 2))];
        expect(r.top).toBeGreaterThanOrEqual(l.bottom - 1);
        expect(o.top).toBeGreaterThanOrEqual(r.bottom - 1);
        await expect(seeAll(section)).toBeVisible();
      } finally {
        await b.context.close();
      }
    });
  });
}

test("at 360 «Por mes» of a goal with no unit fits with the line and «ver todo» (V5)", async ({ person, browser, baseURL, db }) => {
  // Kills: a line wider than the column on the table with no unit.
  const id = await seedMudanza(db, person);
  for (const path of [`/metas/${id}/meses`]) {
    const { page, context } = await open(browser, baseURL, person.sessionFile, path, 360);
    try {
      const scope = page.locator("main");
      const pieces = [lineOf(scope, 13, 14).first(), seeAll(scope).first()];
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

// ---- Paper ---------------------------------------------------------------------------------------------------------

for (const query of ["", "?todo=1"]) {
  test(`V5 and V6 on paper (/exportar${query}): MUDANZA · POR MES · 2 MESES, two rows, «13 meses más, hasta el …», no «ver todo»`, async ({ person, browser, baseURL, db }) => {
    // Kills: the paper dropping the line of a goal with no unit; the paper changing with `?todo=1`; «ver todo» printed.
    await seedMudanza(db, person);
    const paper = await paperOf(browser, baseURL, person.sessionFile, `/exportar${query}`, "Mudanza");
    expect(paper).toContain("mudanza · por mes · 2 de 15 meses");
    expectInOrder(paper, [monthLabel(0), monthLabel(1), lineWords(13, 14)]);
    expect(paper, monthLabel(2)).not.toContain(monthLabel(2));
    expect(paper).not.toContain("ver todo");
  });
}

test("V3 on paper: 14 MESES, the label, the month set by hand, then «1 mes más, hasta el …» (a single month)", async ({ person, browser, baseURL, db }) => {
  // Kills: `restCount > 1` (u5) on paper; the line before the label.
  const id = await seedLeer(db, person, { endsIn: 3 });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 14 de 27 meses");
  expectInOrder(paper, [monthLabel(-11), monthLabel(1), "estos meses con monto propio:", monthLabel(2), lineWords(1, 3)]);
  expect(paper).not.toContain("ver todo");
});

test("C1 on paper: a goal with no end prints the rhythm line, then «y estos meses con monto propio:», then the month", async ({ person, browser, baseURL, db }) => {
  // Kills: moving the rhythm line after the label on paper; dropping «y».
  const id = await seedLeer(db, person, { endsIn: null });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expectInOrder(paper, [monthLabel(1), "los demás meses que vienen: 40 páginas cada uno", "y estos meses con monto propio:", monthLabel(2)]);
  expect(paper).not.toContain("ver todo");
});

// A new «ver todo» reaches the same list the line used to open.
test("V1: «ver todo» of a goal with an end opens the whole list and keeps the first row of next month's sheet", async ({ person, browser, baseURL, db }) => {
  // Kills: «ver todo» to a path other than `?todo=1`; the next-month row losing its sheet.
  const id = await seedLeer(db, person, { endsIn: 3 });
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 360);
  try {
    expect((await rowLink(page, id, 1).first().getAttribute("href")) ?? "").toContain(`planear=${monthKey(1)}`);
    await seeAll(page.locator("main")).click();
    await expect(page).toHaveURL(/todo=1/);
    await expect(rowLink(page, id, 3).first()).toBeVisible();
    expect(await rowMonths(page, id)).toEqual(keysFor(range(-23, 3)));
  } finally {
    await context.close();
  }
});
