import type { Browser } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, todayCount, type Person } from "./fixtures";
import {
  MONTH_LONG,
  monthStart,
  indexOf,
  isoWeekday,
  open,
  plusDays,
  row,
  seedBudget,
  seedCommitment,
  seedGoal,
  seedReached,
  sentence,
  standalone,
  today,
  topOf,
  topOfRow,
} from "./hoy-arbol-seed";
import { boxOf } from "./box";

// `JerarquiaHoy` (RP-84, RP-47, RNP-02, RNP-07): Hoy groups by general goal.
// One block per general with its rows in the tree's order; a row from a large
// or a small goal names only that goal, the general's own row names nothing;
// the holder's month line is the sum of the goals under it. The words are the
// board's, typed here as written.

type Db = postgres.Sql;

async function pageAt(browser: Browser, person: Person, width: number) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    viewport: { width, height: width < 600 ? 740 : 900 },
  });
  return { context, page: await context.newPage() };
}

// The board's tree: a general G with its own row, a large g1 with a row, a
// small p under it with a row, a second large ef; then a loose goal below.
async function seedBoard(db: Db, personId: string) {
  const stamp = Date.now();
  const names = {
    general: `Diseñador junior ${stamp}`,
    large: `Caso uno ${stamp}`,
    small: `Línea base ${stamp}`,
    ef: `EF SET ${stamp}`,
    loose: `Inglés laboral ${stamp}`,
    own: `Registrar las horas ${stamp}`,
    largeRow: `Pulir las pantallas ${stamp}`,
    smallRow: `Medir a un usuario ${stamp}`,
    efRow: `Un bloque de EF ${stamp}`,
    anki: `Anki ${stamp}`,
    shadowing: `Shadowing ${stamp}`,
  };
  const days = [isoWeekday, (isoWeekday % 7) + 1];
  const general = await seedGoal(db, personId, names.general);
  const large = await seedGoal(db, personId, names.large, general);
  const small = await seedGoal(db, personId, names.small, large);
  const ef = await seedGoal(db, personId, names.ef, general);
  const loose = await seedGoal(db, personId, names.loose);
  await seedCommitment(db, personId, general, names.own);
  await seedCommitment(db, personId, large, names.largeRow);
  await seedCommitment(db, personId, small, names.smallRow, { weekdays: days });
  await seedCommitment(db, personId, ef, names.efRow, { amount: 30 });
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on) values
      (${personId}, ${loose}, 'desbloquear la boca', ${plusDays(-10)}, ${plusDays(10)}),
      (${personId}, ${loose}, 'segunda fase', ${plusDays(11)}, ${plusDays(40)}),
      (${personId}, ${loose}, 'tercera fase', ${plusDays(41)}, ${plusDays(80)})
  `;
  await seedCommitment(db, personId, loose, names.anki, { amount: 10 });
  await seedCommitment(db, personId, loose, names.shadowing, { amount: 15 });
  return { names, days, ids: { general, large, small, ef, loose } };
}

for (const width of [360, 1280]) {
  test.describe(`at ${width}`, () => {
    test("the rows of the large and the small goal stand in the general's block, in the tree's order, and the loose goal below (RP-84)", async ({
      person,
      browser,
      db,
    }) => {
      const { names } = await seedBoard(db, person.id);
      const { context, page } = await pageAt(browser, person, width);
      try {
        await open(page);
        // Header tally of the board: six rows ask today.
        await expect(todayCount(page, 0, 6)).toBeVisible();

        const general = await topOf(page, names.general);
        const own = await topOfRow(page, names.own);
        const large = await topOfRow(page, names.largeRow);
        const small = await topOfRow(page, names.smallRow);
        const ef = await topOfRow(page, names.efRow);
        const loose = await topOf(page, names.loose);
        const anki = await topOfRow(page, names.anki);
        const shadowing = await topOfRow(page, names.shadowing);
        expect(general).toBeLessThan(own);
        expect(own).toBeLessThan(large);
        expect(large).toBeLessThan(small);
        expect(small).toBeLessThan(ef);
        expect(ef).toBeLessThan(loose);
        expect(loose).toBeLessThan(anki);
        expect(anki).toBeLessThan(shadowing);
        // The block's label is the general's alone: the general's name stands once as a label.
        expect(await standalone(page, names.general)).toBe(1);

        // Not one block per goal: the large goals' and the small goal's names head no block.
        for (const name of [names.large, names.small, names.ef]) {
          expect(await standalone(page, name), `«${name}» heads a block of its own`).toBe(0);
        }

        // The loose goal keeps its phase: a tag in its header and the aim on one line under it.
        await expect(page.getByText("Fase 1 de 3", { exact: true })).toBeVisible();
        await expect(page.getByText(/desbloquear la boca/i)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("a row from a large or a small goal names only that goal, never the chain (RP-84)", async ({
      person,
      browser,
      db,
    }) => {
      const { names, days } = await seedBoard(db, person.id);
      const { context, page } = await pageAt(browser, person, width);
      try {
        await open(page);
        const large = row(page, names.largeRow);
        await expect(large).toBeVisible();
        await expect(large).toContainText(`${names.large} · todos los días`);
        await expect(large).not.toContainText(names.general);

        const small = row(page, names.smallRow);
        await expect(small).toContainText(`${names.small} · ${sentence(days)}`);
        await expect(small).not.toContainText(names.large);
        await expect(small).not.toContainText(names.general);

        const ef = row(page, names.efRow);
        await expect(ef).toContainText(names.ef);
        await expect(ef).toContainText("30 min");
        await expect(ef).not.toContainText(names.general);
      } finally {
        await context.close();
      }
    });

    test("the general's own row names no goal, and a loose goal's rows are as before (RP-84)", async ({
      person,
      browser,
      db,
    }) => {
      const { names } = await seedBoard(db, person.id);
      const { context, page } = await pageAt(browser, person, width);
      try {
        await open(page);
        const own = row(page, names.own);
        await expect(own).toBeVisible();
        await expect(own).toContainText("todos los días");
        for (const goal of [names.general, names.large, names.small, names.ef, names.loose]) {
          await expect(own).not.toContainText(goal);
        }

        // A goal with no tree above it names nothing on its rows, the group's label says it.
        for (const anki of [row(page, names.anki), row(page, names.shadowing)]) {
          await expect(anki).toContainText("todos los días");
          await expect(anki).not.toContainText(names.loose);
        }
        await expect(row(page, names.anki)).toContainText(/todos los días · 10 min/);
        await expect(row(page, names.shadowing)).toContainText(/todos los días · 15 min/);
      } finally {
        await context.close();
      }
    });

    test("the general's month line says the sum of the goals under it, not its own stored month (RP-80, RP-84)", async ({
      person,
      browser,
      db,
    }) => {
      const stamp = Date.now();
      const names = {
        general: `Meta general ${stamp}`,
        large: `Grande ${stamp}`,
        small: `Chica ${stamp}`,
        row: `Fila ${stamp}`,
      };
      const general = await seedGoal(db, person.id, names.general);
      // A holder keeps a stored month no screen may read.
      await seedBudget(db, person.id, general, 999);
      // The large holds goals too: its own 1200 is stored and unread (RP-80), so the
      // 1200 of the sum sits on a second small goal.
      const large = await seedGoal(db, person.id, names.large, general);
      await seedBudget(db, person.id, large, 700);
      const small = await seedGoal(db, person.id, names.small, large);
      await seedBudget(db, person.id, small, 1020);
      // A done one-off with an estimate: it reaches nothing (RP-128), so the line reads 0 min.
      await seedReached(db, person.id, small, 750);
      const other = await seedGoal(db, person.id, `Otra chica ${stamp}`, large);
      await seedBudget(db, person.id, other, 1200);
      await seedCommitment(db, person.id, small, names.row);
      const { context, page } = await pageAt(browser, person, width);
      try {
        await open(page);
        const line = page.getByText(
          new RegExp(`${MONTH_LONG[Number(today.slice(5, 7)) - 1]}\\s*·\\s*0 min\\s+de\\s+37 h`),
        );
        await expect(line.first()).toBeVisible();
        // Between the general's label and its first row.
        const label = await topOf(page, names.general);
        const lineTop = await indexOf(line.first());
        const first = await topOfRow(page, names.row);
        expect(label).toBeLessThan(lineTop);
        expect(lineTop).toBeLessThan(first);
        // The general's own line, before the name any inner goal puts above its line.
        expect(lineTop).toBeLessThan(await topOf(page, names.large));
        // The 999 minutes stored on the holder are nowhere.
        await expect(page.getByText(/16 h 39 min/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("a large or small goal's month tasks and month line stand under its own name in the general's block (RP-84, RP-80)", async ({
      person,
      browser,
      db,
    }) => {
      const stamp = Date.now();
      const names = {
        general: `General mes ${stamp}`,
        large: `Grande mes ${stamp}`,
        small: `Chica mes ${stamp}`,
        other: `Otra mes ${stamp}`,
        row: `Fila mes ${stamp}`,
        smallTask: `Tarea de la chica ${stamp}`,
        otherTask: `Tarea de la otra ${stamp}`,
      };
      const general = await seedGoal(db, person.id, names.general);
      const large = await seedGoal(db, person.id, names.large, general);
      const small = await seedGoal(db, person.id, names.small, large);
      const other = await seedGoal(db, person.id, names.other, large);
      await seedBudget(db, person.id, small, 600);
      await seedBudget(db, person.id, other, 300);
      // Done one-offs with estimates reach nothing (RP-128): every line reads 0 min.
      await seedReached(db, person.id, small, 150);
      await seedReached(db, person.id, other, 60);
      await seedCommitment(db, person.id, small, names.row);
      for (const [goal, name, estimate] of [
        [small, names.smallTask, 90],
        [other, names.otherTask, 45],
      ] as const) {
        await db`
          insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
          values (${person.id}, ${goal}, ${name}, ${monthStart}::date, ${estimate})
        `;
      }
      const { context, page } = await pageAt(browser, person, width);
      try {
        await open(page);
        const month = MONTH_LONG[Number(today.slice(5, 7)) - 1];
        const smallLine = page.getByText(new RegExp(`${month}\\s*·\\s*0 min\\s+de\\s+10 h`)).locator("visible=true").first();
        const otherLine = page.getByText(new RegExp(`${month}\\s*·\\s*0 min\\s+de\\s+5 h`)).locator("visible=true").first();
        await expect(smallLine).toBeVisible();
        await expect(otherLine).toBeVisible();
        // Each goal's name stands alone above its own line and its own task.
        await expect.poll(() => standalone(page, names.small)).toBe(1);
        await expect.poll(() => standalone(page, names.other)).toBe(1);
        const smallName = await topOf(page, names.small);
        const otherName = await topOf(page, names.other);
        const smallTask = await indexOf(page.getByText(names.smallTask).locator("visible=true").first());
        const otherTask = await indexOf(page.getByText(names.otherTask).locator("visible=true").first());
        const smallAt = await indexOf(smallLine);
        const otherAt = await indexOf(otherLine);
        expect(smallName).toBeLessThan(smallAt);
        expect(smallAt).toBeLessThan(smallTask);
        expect(smallTask).toBeLessThan(otherName);
        expect(otherName).toBeLessThan(otherAt);
        expect(otherAt).toBeLessThan(otherTask);
        // The general's own line is the sum of both.
        await expect(page.getByText(new RegExp(`${month}\\s*·\\s*0 min\\s+de\\s+15 h`)).locator("visible=true").first()).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("three levels of long names fit the width and the group is drawn (RNP-07)", async ({ person, browser, db }) => {
      const stamp = Date.now();
      const long = (what: string) => `${what} con un nombre muy largo que no cabe en una sola línea ${stamp}`;
      const names = { general: long("General"), large: long("Grande"), small: long("Chica"), row: long("Hacer") };
      const general = await seedGoal(db, person.id, names.general);
      const large = await seedGoal(db, person.id, names.large, general);
      const small = await seedGoal(db, person.id, names.small, large);
      await seedCommitment(db, person.id, small, names.row, { amount: 30 });
      await seedBudget(db, person.id, small, 600);
      const { context, page } = await pageAt(browser, person, width);
      try {
        await open(page);
        await expect(page.getByText(names.general, { exact: true }).locator("visible=true").first()).toBeVisible();
        const rowBox = (await boxOf(row(page, names.row)));
        await expect(row(page, names.row)).toContainText(names.small);
        expect(rowBox.x).toBeGreaterThanOrEqual(0);
        expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const wide = await page.evaluate((limit) => {
          return Array.from(document.querySelectorAll("main *")).filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.right > limit + 0.5;
          }).length;
        }, width);
        expect(wide).toBe(0);
        // The general heads its block above the row.
        expect(await topOf(page, names.general)).toBeLessThan(await topOfRow(page, names.row));
      } finally {
        await context.close();
      }
    });
  });
}

test("a tap on the small goal's row from the general's block is one POST and the row becomes done (RNP-02)", async ({
  person,
  browser,
  db,
}) => {
  const stamp = Date.now();
  const names = { general: `General marca ${stamp}`, small: `Chica marca ${stamp}`, row: `Marcar ${stamp}` };
  const general = await seedGoal(db, person.id, names.general);
  const large = await seedGoal(db, person.id, `Grande marca ${stamp}`, general);
  const small = await seedGoal(db, person.id, names.small, large);
  const commitment = await seedCommitment(db, person.id, small, names.row);
  await seedCommitment(db, person.id, general, `Otra ${stamp}`);
  const { context, page } = await pageAt(browser, person, 390);
  try {
    await open(page);
    await expect(row(page, names.row)).toContainText(names.small);
    expect(await topOf(page, names.general)).toBeLessThan(await topOfRow(page, names.row));
    await expect(todayCount(page, 0, 2)).toBeVisible();

    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) posts.push(request.url());
    });
    await row(page, names.row).click();
    await expect(todayCount(page, 1, 2)).toBeVisible();
    await expect
      .poll(async () => (await db`select 1 from goals.facts where commitment_id = ${commitment}`).length)
      .toBe(1);
    expect(posts).toHaveLength(1);
    // Still in the same block, now done: the row's mark is the accent, the tally counted it.
    await expect(row(page, names.row)).toContainText(names.small);
  } finally {
    await context.close();
  }
});
