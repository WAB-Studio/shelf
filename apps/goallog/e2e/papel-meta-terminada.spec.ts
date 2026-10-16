import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";
import { boxOf } from "./box";

// Decision of 2026-10-11, after the train-10 critic saw «Sprint / terminada el …» end page 6 and
// «AL TERMINAR …» open page 7: an ended goal's name, its «terminada el …» line and its «al terminar»
// figure are one block, and a page never cuts it. On screen nothing changes. Ended goals follow the open ones.
const A4 = { width: 794, height: 1123 };

const daysFromToday = (days: number) => {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
};
const thisMonth = () => `${todayInZone().slice(0, 7)}-01`;

// Ended goal: horizon already passed, so `endedOn` is the day before it.
async function seedEnded(db: postgres.Sql, person: Person, name: string, withUnit: boolean): Promise<string> {
  const [goal] = withUnit
    ? await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
        values (${person.id}, ${name}, ${daysFromToday(-3)}::date, 'distancia', 'km',
                (${daysFromToday(-60)}::date + interval '12 hours')::timestamptz)
        returning id`
    : await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, created_at)
        values (${person.id}, ${name}, ${daysFromToday(-3)}::date,
                (${daysFromToday(-60)}::date + interval '12 hours')::timestamptz)
        returning id`;
  if (withUnit) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${thisMonth()}::date, 40)`;
  }
  return goal.id;
}

// Open goal whose k tasks are the padding that moves every page cut after it.
async function seedOpen(db: postgres.Sql, person: Person, name: string, tasks: number): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${daysFromToday(200)}::date, 'distancia', 'km',
            (${daysFromToday(-10)}::date + interval '12 hours')::timestamptz)
    returning id`;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${thisMonth()}::date, 40)`;
  for (let n = 1; n <= tasks; n++) {
    await db`
      insert into goals.one_offs (user_id, goal_id, name, planned_month)
      values (${person.id}, ${goal.id}, ${`Tarea ${n}`}, ${thisMonth()}::date)`;
  }
  return goal.id;
}

async function open(browser: Browser, baseURL: string, person: Person) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport: A4 });
  const page = await context.newPage();
  await page.goto("/exportar");
  return { context, page };
}

async function printed(page: Page, label: string): Promise<string> {
  await page.emulateMedia({ media: "print" });
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `papel-terminada-${label}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

function pagesOf(file: string): string[] {
  const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const count = Number(/Pages:\s+(\d+)/.exec(info)![1]);
  return Array.from({ length: count }, (_, i) =>
    execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], { encoding: "utf8" })
      .toLowerCase()
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" "),
  );
}

const remove = (db: postgres.Sql, person: Person, ids: string[]) =>
  db`delete from goals.goals where id = any(${ids}::uuid[]) and user_id = ${person.id}`;

test.describe("the paper report: an ended goal is never cut between pages", () => {
  // k tasks before three ended goals move the cut through their blocks, a row at a time. Three blocks
  // in a row give three chances per page of a cut landing inside one of them.
  const SWEEP = Array.from({ length: 33 }, (_, i) => i);
  for (const k of SWEEP) {
    test(`with ${k} tasks before them, each ended goal's name, «terminada el» and «al terminar» share one page`, async ({
      person, browser, baseURL, db,
    }) => {
      const stamp = Date.now();
      const names = ["A", "B", "C"].map((letter) => `Sprint${letter} ${stamp}`);
      const ids: string[] = [];
      for (const name of names) ids.push(await seedEnded(db, person, name, true));
      ids.push(await seedOpen(db, person, `Abierta ${stamp}`, k));
      const { context, page } = await open(browser, baseURL!, person);
      try {
        await expect(page.getByRole("main").getByText(names[0], { exact: true }).first()).toBeVisible();
        const pages = pagesOf(await printed(page, `k${k}`));
        for (const [i, name] of names.entries()) {
          const lower = name.toLowerCase();
          const holders = pages.filter((p) => p.includes(lower));
          expect(holders, `${name} is printed on exactly one page`).toHaveLength(1);
          const flat = holders[0];
          const from = flat.indexOf(lower);
          const next = i + 1 < names.length ? flat.indexOf(names[i + 1].toLowerCase(), from) : -1;
          const own = flat.slice(from, next === -1 ? undefined : next);
          expect(own, `«terminada el» on the page of ${name}`).toContain("terminada el");
          expect(own, `«al terminar» on the page of ${name}`).toContain("al terminar");
        }
        expect(pages.join(" ").split("al terminar").length - 1, "«al terminar» printed once per goal").toBe(3);
      } finally {
        await context.close();
        await remove(db, person, ids);
      }
    });
  }

  test("an ended goal with no unit stays whole: name and «terminada el» on one page, at every position", async ({
    person, browser, baseURL, db,
  }) => {
    // One run, many positions: each pass re-seeds the padding and re-prints.
    const stamp = Date.now();
    const sprint = `Sprint ${stamp}`;
    const ended = await seedEnded(db, person, sprint, false);
    const open_ = await seedOpen(db, person, `Abierta ${stamp}`, 0);
    const { context, page } = await open(browser, baseURL!, person);
    try {
      for (let k = 0; k <= 32; k++) {
        if (k > 0) {
          await db`insert into goals.one_offs (user_id, goal_id, name, planned_month)
                   values (${person.id}, ${open_}, ${`Tarea ${k}`}, ${thisMonth()}::date)`;
        }
        await page.goto("/exportar");
        await expect(page.getByRole("main").getByText(sprint, { exact: true }).first()).toBeVisible();
        const pages = pagesOf(await printed(page, `sinmedida-${k}`));
        const holders = pages.filter((p) => p.includes(sprint.toLowerCase()));
        expect(holders, `k=${k}: the name is printed on exactly one page`).toHaveLength(1);
        expect(holders[0].slice(holders[0].indexOf(sprint.toLowerCase())), `k=${k}: «terminada el» with the name`).toContain(
          "terminada el",
        );
        expect(holders[0], `k=${k}: no figure for a goal with no unit`).not.toContain("al terminar");
        await page.emulateMedia({ media: "screen" });
      }
    } finally {
      await context.close();
      await remove(db, person, [ended, open_]);
    }
  });

  test("on screen the ended goal's block keeps its height: its content, nothing added, and no page-break rule", async ({
    person, browser, baseURL, db,
  }) => {
    const stamp = Date.now();
    const sprint = `Sprint ${stamp}`;
    const ids = [await seedEnded(db, person, sprint, true), await seedOpen(db, person, `Abierta ${stamp}`, 2)];
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await expect(page.getByRole("main").getByText(sprint, { exact: true }).first()).toBeVisible();
      const block = page
        .locator("section")
        .filter({ has: page.getByRole("heading", { name: sprint }) })
        .last();
      const box = (await boxOf(block));
      // Reference measured here: the extent of the block's own children, which is what its height was before.
      const kids = await block.locator(":scope > *").evaluateAll((els) => {
        const rects = els.map((el) => el.getBoundingClientRect());
        return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
      });
      expect(Math.abs(box.height - (kids.bottom - kids.top))).toBeLessThanOrEqual(1);
      expect(await block.evaluate((el) => getComputedStyle(el).breakInside)).toBe("auto");
    } finally {
      await context.close();
      await remove(db, person, ids);
    }
  });

  test("ended goals still follow the open ones on paper, though they were created first", async ({
    person, browser, baseURL, db,
  }) => {
    const stamp = Date.now();
    const sprint = `Sprint ${stamp}`;
    const abierta = `Abierta ${stamp}`;
    const ids = [await seedEnded(db, person, sprint, true), await seedOpen(db, person, abierta, 1)];
    const { context, page } = await open(browser, baseURL!, person);
    try {
      await expect(page.getByRole("main").getByText(sprint, { exact: true }).first()).toBeVisible();
      const flat = pagesOf(await printed(page, "orden")).join(" ");
      const open0 = flat.indexOf(abierta.toLowerCase());
      const ended0 = flat.indexOf(sprint.toLowerCase());
      expect(open0).toBeGreaterThanOrEqual(0);
      expect(ended0).toBeGreaterThan(open0);
    } finally {
      await context.close();
      await remove(db, person, ids);
    }
  });
});
