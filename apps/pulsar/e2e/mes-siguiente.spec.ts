import { test, expect } from "./fixtures";
import { PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel, monthStartOf } from "./sin-final-seed";
import {
  AND_OWN,
  OLD_AHEAD,
  OWN,
  budget,
  expectInOrder,
  keysFor,
  lineLink,
  longMonth,
  mainLower,
  monthHref,
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
  seedLeer,
  textOf,
  yOf,
} from "./mes-siguiente-seed";

// Module 939, RP-110: a goal with no end shows next month as its own row, with its amount, «sin monto» or its tasks.
// The row opens the amount sheet (`?planear=<mes>`) when the goal has a unit and holds no goals; every other row opens
// its month. Under the current month the order is: next month, «los demás meses que vienen: N cada uno», «y estos
// meses con monto propio:» and the months set by hand. «Por mes», the report and paper say it in the same order.
// Contract: private/contrato-939.md (E1, E1-6, E1b, E1c, E1d); decisions of 2026-10-13 in docs/pulsar/DESIGN.md win over the
// board. Each test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const planearOf = (offset: number) => new RegExp(`/metas/[0-9a-f-]+/meses\\?(?:[^#]*&)?planear=${monthKey(offset)}(?:&|$)`);

for (const width of [360, 1280]) {
  test.describe(`«Por mes» at ${width}`, () => {
    test("E1: 13 months up to next month, then the line, the label and a second table with the month set by hand (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the order of s3 (the hand-set month above the line); `handSet` left in the first table; the count not counting next month.
      const id = await seedLeer(db, person);
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 2)));
        expect(await mainLower(page)).toContain("14 meses");
        await expect(rowLink(page, id, 0)).toContainText("en curso");
        const next = rowLink(page, id, 1);
        await expect(next).toContainText("planeado");
        await expect(next).toContainText("40");
        const own = rowLink(page, id, 2);
        await expect(own).toContainText("60");
        const line = lineLink(page.locator("main"));
        const label = textOf(page.locator("main"), AND_OWN);
        await expect(line).toBeVisible();
        await expect(label).toBeVisible();
        const [n, l, r, o] = [await yOf(next), await yOf(line), await yOf(label), await yOf(own)];
        expect(l.top, "the line under next month").toBeGreaterThanOrEqual(n.bottom - 1);
        expect(r.top, "the label under the line").toBeGreaterThanOrEqual(l.bottom - 1);
        expect(o.top, "the hand-set month under the label").toBeGreaterThanOrEqual(r.bottom - 1);
        // The hand-set month is in another table than next month's.
        const first = next.first().locator("xpath=ancestor::*[self::table or self::ol][1]");
        await expect(first.locator("a", { hasText: new RegExp(monthLabel(2), "i") })).toHaveCount(0);
        await expect(first.locator("a", { hasText: new RegExp(monthLabel(1), "i") }).first()).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("the line says «los demás meses que vienen: 40 páginas cada uno», opens `?todo=1`, and the old wording is gone (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the wording of s3 («los meses que vienen»); a line with no link; a link to anywhere but the whole list.
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const line = lineLink(page.locator("main"));
        await expect(line).toBeVisible();
        expect((await line.getAttribute("href")) ?? "").toContain("todo=1");
        expect(await mainLower(page)).not.toMatch(OLD_AHEAD);
        // Next month is a row, so it is not in the fold, and there is no label without a hand-set month.
        await expect(textOf(page.locator("main"), AND_OWN)).toHaveCount(0);
        await expect(textOf(page.locator("main"), OWN)).toHaveCount(0);
        const next = await yOf(rowLink(page, id, 1));
        expect((await yOf(line)).top).toBeGreaterThanOrEqual(next.bottom - 1);
        expect((await yOf(seeAll(page.locator("main")))).top).toBeGreaterThanOrEqual((await yOf(line)).bottom - 1);
      } finally {
        await context.close();
      }
    });

    test("next month's row opens the amount sheet at `?planear=<mes>` (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: `hrefOf` for next month leading to its page; the sheet not opening.
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const href = (await rowLink(page, id, 1).first().getAttribute("href")) ?? "";
        expect(href).toMatch(planearOf(1));
        await rowLink(page, id, 1).first().click();
        await expect(page).toHaveURL(planearOf(1));
        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole("heading", { name: `¿Cuánto en ${monthName(1)}?` })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("every other row leads to its month's page, the current month and a hand-set one among them (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: `?planear=` for every row to come.
      const id = await seedLeer(db, person);
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const targets = await monthTargets(page, id);
        for (const offset of [-11, -1, 0, 2]) expect(targets[monthKey(offset)], monthLabel(offset)).toEqual([monthHref(id, offset)]);
        await rowLink(page, id, 2).first().click();
        await expect(page).toHaveURL(new RegExp(`${monthHref(id, 2)}$`));
      } finally {
        await context.close();
      }
    });

    test("the sheet of next month writes: 50 pages and next month reads «planeado» 50, back on the list (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the sheet losing `volver`; the amount going to another month; the row not showing it.
      const id = await seedLeer(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await rowLink(page, id, 1).first().click();
        const sheet = page.getByRole("dialog");
        await sheet.getByLabel("cuánto, en páginas").fill("50");
        await sheet.getByRole("button", { name: "Guardar" }).click();
        await expect(sheet).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/metas/${id}/meses$`));
        const next = rowLink(page, id, 1);
        await expect(next.first()).toContainText("50");
        await expect(next.first()).toContainText("planeado");
        const rows = await db<{ month: string; amount: number }[]>`select month::text as month, amount from goals.month_budgets where goal_id = ${id}`;
        expect(rows).toEqual([{ month: monthStartOf(1), amount: 50 }]);
        // Set by hand now, next month is still a single row and the line still says 40.
        expect(await rowMonths(page, id)).toEqual(keysFor(range(-11, 1)));
        await expect(lineLink(page.locator("main"))).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("E1-6: next month set by hand at 55 is one row, not repeated under the label; the line stays at 40 (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: repeating `next` among the hand-set months.
      const id = await seedLeer(db, person);
      await budget(db, person, id, 1, 55);
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const next = rowLink(page, id, 1);
        await expect(next.first()).toContainText("55");
        await expect(next.first()).toContainText("planeado");
        // One row per table layout: stack and wide draw it twice, one of them hidden.
        await expect(next).toHaveCount(1);
        await expect(rowLink(page, id, 2)).toHaveCount(1);
        await expect(lineLink(page.locator("main"))).toBeVisible();
        await expect(textOf(page.locator("main"), AND_OWN)).toBeVisible();
        const second = rowLink(page, id, 2).first().locator("xpath=ancestor::*[self::table or self::ol][1]");
        await expect(second.locator("a", { hasText: new RegExp(monthLabel(1), "i") })).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("E1b: with no rhythm next month reads «sin monto», has no «planeado», opens the sheet, and no line is drawn (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: `next` kept only when it has an amount.
      const id = await seedLeer(db, person, { rhythm: null, opened: -2 });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect(await rowMonths(page, id)).toEqual(keysFor([-2, -1, 0, 1]));
        await expect(rowLink(page, id, 0)).toContainText("en curso");
        const next = rowLink(page, id, 1).first();
        await expect(next).toContainText("sin monto");
        expect((await next.innerText()).toLowerCase()).not.toContain("planeado");
        expect(await mainLower(page)).not.toContain("meses que vienen");
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
        expect(await mainLower(page)).toContain("4 meses");
        await next.click();
        await expect(page).toHaveURL(planearOf(1));
        await expect(page.getByRole("dialog")).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("with no rhythm and a month set by hand the label drops its «y»: «estos meses con monto propio:» and 60 (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the label with «y» when there is no line.
      const id = await seedLeer(db, person, { rhythm: null, opened: -2 });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        await expect(textOf(page.locator("main"), OWN)).toBeVisible();
        await expect(textOf(page.locator("main"), AND_OWN)).toHaveCount(0);
        await expect(rowLink(page, id, 1).first()).toContainText("sin monto");
        await expect(rowLink(page, id, 2).first()).toContainText("60");
        expect(await mainLower(page)).not.toContain("meses que vienen");
        const label = await yOf(textOf(page.locator("main"), OWN));
        expect((await yOf(rowLink(page, id, 2))).top).toBeGreaterThanOrEqual(label.bottom - 1);
        expect((await yOf(rowLink(page, id, 1))).bottom).toBeLessThanOrEqual(label.top + 1);
      } finally {
        await context.close();
      }
    });

    test("E1c: opened this month, the rows are this month and next, the line says 33, and there is no «ver todo» (b11, RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: «ver todo» drawn when nothing is hidden (`hidden >= 0`); next month left at another rhythm.
      const id = await seedOpenGoal(db, person, { name: "Escribir", unit: PAGES, horizon: null, rhythm: 33, created: openedOnDay(6).at });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        expect(await rowMonths(page, id)).toEqual(keysFor([0, 1]));
        await expect(rowLink(page, id, 1).first()).toContainText("33");
        await expect(rowLink(page, id, 1).first()).toContainText("planeado");
        await expect(page.getByRole("link", { name: /los demás meses que vienen: 33 páginas cada uno/i })).toBeVisible();
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("E1d: a goal with no unit reads next month as «1 tarea» and the row leads to its page, with no other month ahead (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: `?planear=` for a goal that measures nothing.
      const id = await seedOpenGoal(db, person, { name: "Vivir mejor", unit: null, horizon: null, created: openedIn(-2) });
      for (const [offset, count] of [[1, 1], [3, 2], [5, 1]] as const) {
        for (let i = 0; i < count; i++) {
          await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${id}, ${`Tarea ${offset}-${i}`}, ${monthStartOf(offset)}::date)`;
        }
      }
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const targets = await monthTargets(page, id);
        expect(Object.keys(targets).sort()).toEqual(keysFor([-2, -1, 0, 1]));
        expect(targets[monthKey(1)]).toEqual([monthHref(id, 1)]);
        await expect(rowLink(page, id, 1).first()).toContainText("1 tarea");
        await expect(rowLink(page, id, 0)).toContainText("en curso");
      } finally {
        await context.close();
      }
    });

    test("`?todo=1` lists 35 months in order, next month leading to its page, with no line and no label (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the line or the label drawn with `all`; `?planear=` for next month on the whole list.
      const id = await seedLeer(db, person);
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        const targets = await monthTargets(page, id);
        expect(Object.keys(targets).sort()).toEqual(keysFor(range(-23, 11)));
        for (const offset of range(-23, 11)) expect(targets[monthKey(offset)], monthLabel(offset)).toEqual([monthHref(id, offset)]);
        expect(await mainLower(page)).not.toMatch(/meses que vienen|monto propio/);
        await expect(seeAll(page.locator("main"))).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("an end of 30 months folds as a goal with no end: 2 rows, the line «28 meses más, hasta el …» as text, «ver todo», no label (RP-110, RP-115, RP-116)", async ({ person, browser, baseURL, db }) => {
      // Kills: the cut left for a goal with no end alone (the s4 rule); the sheet link missing on a goal with an end.
      const horizon = monthStartOf(30);
      const id = await seedOpenGoal(db, person, {
        name: "Con final",
        unit: PAGES,
        horizon,
        rhythm: 40,
        created: openedIn(0) > new Date() ? new Date() : openedIn(0),
      });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const targets = await monthTargets(page, id);
        expect(Object.keys(targets).sort()).toEqual(keysFor([0, 1]));
        expect(targets[monthKey(0)]).toEqual([monthHref(id, 0)]);
        expect(targets[monthKey(1)]?.[0]).toMatch(planearOf(1));
        expect(await mainLower(page)).toMatch(/28 meses más, hasta el \d{1,2} \p{L}{3} \d{4}/u);
        expect(await mainLower(page)).not.toMatch(/cada uno|monto propio/);
        await expect(page.getByRole("link", { name: /\d+ meses más, hasta el/, includeHidden: true })).toHaveCount(0);
        await expect(seeAll(page.locator("main"))).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("a group with no end: its next month is a row to its page, with no line of its own (RP-80, RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the sheet link or a rhythm line on a goal that holds goals.
      const group = await seedOpenGoal(db, person, { name: "Grupo", horizon: null, created: openedIn(-2) });
      await seedOpenGoal(db, person, { name: "Hijo", parent: group, unit: PAGES, horizon: null, rhythm: 40, created: openedIn(-2) });
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${group}/meses`, width);
      try {
        const targets = await monthTargets(page, group);
        for (const offset of [-2, -1, 0, 1]) expect(targets[monthKey(offset)], monthLabel(offset)).toEqual([monthHref(group, offset)]);
        expect(await mainLower(page)).not.toContain("cada uno");
      } finally {
        await context.close();
      }
    });
  });
}

// ---- The report on screen -----------------------------------------------------------------------------------------

for (const width of [360, 1280]) {
  test.describe(`the report at ${width}`, () => {
    test("E1: the same order as «Por mes»: 12 months and next month, the line, the label, the hand-set month (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the report keeping the order of s3 (the hand-set month above the line); the old wording.
      const name = "Leer";
      const id = await seedLeer(db, person, { name });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        for (const offset of range(-11, 2)) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(1);
        for (const offset of [-12, 3]) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(0);
        await expect(reportRow(section, 1)).toContainText("40");
        await expect(reportRow(section, 2)).toContainText("60");
        const line = lineLink(section);
        const label = textOf(section, AND_OWN);
        await expect(line).toBeVisible();
        await expect(label).toBeVisible();
        expect(await section.innerText()).not.toMatch(OLD_AHEAD);
        const [n, l, r, o] = [await yOf(reportRow(section, 1)), await yOf(line), await yOf(label), await yOf(reportRow(section, 2))];
        expect(l.top).toBeGreaterThanOrEqual(n.bottom - 1);
        expect(r.top).toBeGreaterThanOrEqual(l.bottom - 1);
        expect(o.top).toBeGreaterThanOrEqual(r.bottom - 1);
        await expect(seeAll(section)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("E1c: a goal opened this month has no «ver todo» in the report (b11, RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: `cut.hidden >= 0` on the report.
      const name = "Escribir";
      await seedOpenGoal(db, person, { name, unit: PAGES, horizon: null, rhythm: 33, created: openedOnDay(6).at });
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        await expect(reportRow(section, 1)).toContainText("33");
        await expect(section.getByRole("link", { name: /los demás meses que vienen: 33 páginas cada uno/i })).toBeVisible();
        await expect(seeAll(section)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("`?todo=1` opens every month from the opening to the last one ahead, without the line, the label or the link (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the report ignoring `todo`.
      const name = "Leer";
      const id = await seedLeer(db, person, { name });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        for (const offset of range(-23, 11)) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(1);
        for (const offset of [-24, 12]) await expect(reportRow(section, offset), monthLabel(offset)).toHaveCount(0);
        await expect(lineLink(section)).toHaveCount(0);
        await expect(textOf(section, AND_OWN)).toHaveCount(0);
        await expect(seeAll(section)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("with no rhythm the report draws next month «sin monto» and the label without «y» before the hand-set month (RP-110)", async ({ person, browser, baseURL, db }) => {
      // Kills: the label with «y» and no line; `next` dropped from the report when empty.
      const name = "Leer";
      const id = await seedLeer(db, person, { name, rhythm: null, opened: -2 });
      await budget(db, person, id, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
        const section = sectionOf(page, name);
        await expect(reportRow(section, 1)).toContainText("sin monto");
        await expect(reportRow(section, 2)).toContainText("60");
        await expect(textOf(section, OWN)).toBeVisible();
        await expect(textOf(section, AND_OWN)).toHaveCount(0);
        await expect(reportRow(section, 3)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

// ---- Paper --------------------------------------------------------------------------------------------------------

for (const query of ["", "?todo=1"]) {
  test(`E1 on paper (/exportar${query}): the 12 months, next month, the line, the label, the second table; the count says what is printed (RP-110)`, async ({ person, browser, baseURL, db }) => {
    // Kills: printing in month order (s3: the hand-set month above the line); `?todo=1` changing the paper.
    const id = await seedLeer(db, person);
    await budget(db, person, id, 2, 60);
    const paper = await paperOf(browser, baseURL, person.sessionFile, `/exportar${query}`, "Leer");
    expectInOrder(paper, [
      monthLabel(-11), monthLabel(0), monthLabel(1),
      "los demás meses que vienen: 40 páginas cada uno",
      "y estos meses con monto propio:",
      monthLabel(2),
    ]);
    for (const offset of [-12, 3]) expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
    expect(paper).not.toMatch(/\blos meses que vienen\b/);
    expect(paper).not.toContain("ver todo");
  });
}

test("E1 on paper with nothing set by hand: the count says 13 and there is no label (RP-110)", async ({ person, browser, baseURL, db }) => {
  // Kills: the count not counting the printed next month; a label with no hand-set month.
  await seedLeer(db, person);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 13 meses");
  expectInOrder(paper, [monthLabel(0), monthLabel(1), "los demás meses que vienen: 40 páginas cada uno"]);
  expect(paper).not.toContain("monto propio");
});

test("E1b on paper: next month is printed «sin monto» though empty, and a goal with no end names none of the rest (RP-110, RP-118)", async ({ person, browser, baseURL, db }) => {
  // Kills: `printsOnPaper` without `next`; the «…: sin monto» line of a goal with no end.
  await seedLeer(db, person, { rhythm: null, opened: -2 });
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 4 meses");
  expectInOrder(paper, [monthLabel(-2), monthLabel(0), monthLabel(1), "sin monto"]);
  expect(paper, "no fold line").not.toContain(": sin monto");
  for (const offset of [2, 11]) expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
});

test("E1d on paper: a goal with no unit prints its months with tasks in month order, and with no end no line for the empty ones (b13, RP-110, RP-118)", async ({ person, browser, baseURL, db }) => {
  // Kills: months with tasks printed out of order (Jan 2027 after Mar 2027); the «…: sin tareas» line of a goal with no end.
  const id = await seedOpenGoal(db, person, { name: "Vivir mejor", unit: null, horizon: null, created: openedIn(-2) });
  // Written out of order on purpose: the later month first.
  for (const [offset, count] of [[5, 1], [1, 1], [3, 2]] as const) {
    for (let i = 0; i < count; i++) {
      await db`insert into goals.one_offs (user_id, goal_id, name, planned_month) values (${person.id}, ${id}, ${`Tarea ${offset}-${i}`}, ${monthStartOf(offset)}::date)`;
    }
  }
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Vivir mejor");
  expect(paper).toContain("vivir mejor · por mes · 6 meses");
  // The six printed rows, by name and in month order, so the count cannot pass on other rows.
  expectInOrder(paper, [monthLabel(-2), monthLabel(-1), monthLabel(0), monthLabel(1), monthLabel(3), monthLabel(5)]);
  expect(paper, "no «sin tareas» line").not.toContain(": sin tareas");
  for (const offset of [2, 4]) {
    expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
    expect(paper, longMonth(offset)).not.toContain(longMonth(offset));
  }
});

test("a group with no end prints, on paper, its closed months, the current one and the one that comes (RP-80, RP-110)", async ({ person, browser, baseURL, db }) => {
  // Kills: filtering `past` out of the group; dropping its next month.
  const group = await seedOpenGoal(db, person, { name: "Grupo", horizon: null, created: openedIn(-3) });
  // The goal inside opened this month: the closed months can only be the group's own.
  await seedOpenGoal(db, person, { name: "Hijo", parent: group, unit: PAGES, horizon: null, rhythm: 40, created: new Date(Date.now() - 86_400_000) });
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Grupo");
  expectInOrder(paper, [monthLabel(-3), monthLabel(-2), monthLabel(-1), monthLabel(0), monthLabel(1)]);
});

// ---- 360 ------------------------------------------------------------------------------------------------------------

test("at 360 «Por mes» and the report fit with the line, the label, the second table and «ver todo» (RP-110)", async ({ person, browser, baseURL, db }) => {
  // Kills: a line or a label wider than the column, pushing the page sideways.
  const id = await seedLeer(db, person, { name: "Leer largo para medir el ancho de la línea y del rótulo" });
  await budget(db, person, id, 2, 60);
  for (const path of [`/metas/${id}/meses`, "/exportar"]) {
    const { page, context } = await open(browser, baseURL, person.sessionFile, path, 360);
    try {
      const scope = page.locator("main");
      const pieces = [lineLink(scope).first(), textOf(scope, AND_OWN).first(), seeAll(scope).first()];
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
