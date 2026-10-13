import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

// `ReportePlegado.dc.html` and `ReporteImpresoMeses.dc.html` (RP-49):
// on screen a goal's weeks sit folded under its months; on paper only the months print,
// and a section runs on across pages between its rows.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// Long enough that the month's tasks cannot fit page 1 after the head and the first sections.
const LONG_NOTE = Array.from({ length: 400 }, (_, i) => `n${String(i).padStart(3, "0")}`)
  .join(" ")
  .slice(0, 2000);

async function seed(db: postgres.Sql, person: Person) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const today = todayInZone();
  const monthStart = `${today.slice(0, 7)}-01`;
  const name = `Meta plegada ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${plusDays(90)}, 'minutos', 'minutos', now() - interval '70 days')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${monthStart}::date, 720),
           (${person.id}, ${goal.id}, (${monthStart}::date - interval '1 month')::date, 600)
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Sesión ${stamp}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '70 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${commitment.id}, ${today}::date, 90)
  `;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, note)
    values (${person.id}, ${goal.id}, ${`Tarea ${stamp}`}, ${monthStart}::date, ${LONG_NOTE})
    returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, parent_id, name, estimate, note)
    values (${person.id}, ${goal.id}, ${task.id}, ${`Subtarea ${stamp}`}, 45, ${LONG_NOTE})
  `;
  return { goalId: goal.id, name };
}

const remove = (db: postgres.Sql, person: Person, ids: string[]) =>
  db`delete from goals.goals where id = any(${ids}) and user_id = ${person.id}`;

test.describe("the report folds its weeks (RP-49)", () => {
  for (const width of [360, 1280] as const) {
    test(`at ${width} the weeks are folded by default, the count is real and «en curso» keeps one line`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const seeded = await seed(db, person);
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/exportar");
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
        // The label and the table the board draws.
        await expect(main.getByText(`${seeded.name} · por mes`, { exact: true })).toBeVisible();
        if (width === 1280) {
          await expect(main.locator("table thead").first().locator("th")).toHaveText(["mes", "hecho", "planeado"]);
        }
        await expect(main.getByText("por semana", { exact: true })).toBeVisible();
        await expect(main.getByText(/^Esta semana: .*\.$/)).toBeVisible();

        const status = main.getByText("en curso", { exact: true }).locator("visible=true").first();
        await expect(status).toBeVisible();
        const lines = await status.evaluate((node) => {
          const style = getComputedStyle(node);
          return node.getBoundingClientRect().height / parseFloat(style.lineHeight);
        });
        expect(lines, "«en curso» on one line").toBeLessThan(1.5);

        // Closed by default: the link-card says how many, no week row is visible.
        const fold = main.locator("summary", { hasText: /^Ver las \d+ semanas$/ });
        await expect(fold).toBeVisible();
        const count = Number(/\d+/.exec((await fold.textContent()) ?? "")![0]);
        const weekRow = main.getByText(/^sem \d+ · /).locator("visible=true");
        await expect(weekRow).toHaveCount(0);

        await fold.click();
        await expect(weekRow.first()).toBeVisible();
        // A week crossing two months is one week: the count the card promised.
        const labels = await weekRow.allTextContents();
        expect(new Set(labels.map((label) => /^sem (\d+)/.exec(label)![1])).size).toBe(count);
        expect(labels).toHaveLength(count);
      } finally {
        await context.close();
        await remove(db, person, [seeded.goalId]);
      }
    });
  }

  test("on paper no week prints, «en curso» keeps one line and page 1 is used to its foot", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const first = await seed(db, person);
    const second = await seed(db, person);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
    });
    try {
      const page = await context.newPage();
      await page.goto("/exportar");
      await expect(page.getByRole("main").getByRole("heading", { name: first.name, exact: true })).toBeVisible();
      // Open on screen: the print rule, not the fold's state, keeps the weeks off the sheet.
      for (const summary of await page.locator("summary", { hasText: /^Ver las \d+ semanas$/ }).all()) {
        await summary.click();
      }
      await expect(page.getByText(/^sem \d+ · /).locator("visible=true").first()).toBeVisible();

      await page.emulateMedia({ media: "print" });
      await expect(page.getByText(/^sem \d+ · /).locator("visible=true")).toHaveCount(0);
      await expect(page.getByText("por semana", { exact: true }).locator("visible=true")).toHaveCount(0);
      await expect(page.locator("summary").locator("visible=true")).toHaveCount(0);
      const status = page.getByText("en curso", { exact: true }).locator("visible=true").first();
      const lines = await status.evaluate((node) => {
        const style = getComputedStyle(node);
        return node.getBoundingClientRect().height / parseFloat(style.lineHeight);
      });
      expect(lines, "«en curso» on one line").toBeLessThan(1.5);

      const dir = resolve(process.cwd(), "private/export-pdf");
      mkdirSync(dir, { recursive: true });
      const file = resolve(dir, `379-${first.goalId}.pdf`);
      writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
      const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
      expect(text).not.toMatch(/sem \d+ ·/);
      expect(text).not.toContain("Ver las");
      expect(text.toLowerCase()).toContain(`${first.name} · por mes`.toLowerCase());

      // Page 1 is the summary and the annex opens on page 2 (ExportarResumen, 2026-10-13). Page 2's last word
      // sits in the lower quarter of the sheet: no section jumped a page and left a gap.
      const box = execFileSync("pdftotext", ["-bbox", "-f", "2", "-l", "2", file, "-"], { encoding: "utf8" });
      const height = Number(/<page width="[\d.]+" height="([\d.]+)"/.exec(box)![1]);
      const bottoms = [...box.matchAll(/yMax="([\d.]+)"/g)].map((found) => Number(found[1]));
      const last = Math.max(...bottoms);
      expect(last, `page 2 ends at ${last} of ${height}`).toBeGreaterThanOrEqual(height * 0.75);
    } finally {
      await context.close();
      await remove(db, person, [first.goalId, second.goalId]);
    }
  });

  // `pdftotext -bbox` words of the printed report, page by page, grouped into lines.
  type Line = { page: number; top: number; bottom: number; text: string };
  function printedLines(file: string): Line[] {
    const box = execFileSync("pdftotext", ["-bbox", file, "-"], { encoding: "utf8" });
    const lines: Line[] = [];
    let page = 0;
    const words: { page: number; x: number; right: number; top: number; bottom: number; text: string }[] = [];
    for (const raw of box.split("\n")) {
      if (raw.includes("<page ")) page += 1;
      const found = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*)<\/word>/.exec(raw);
      if (found) {
        words.push({ page, x: Number(found[1]), right: Number(found[3]), top: Number(found[2]), bottom: Number(found[4]), text: found[5] });
      }
    }
    // Side-by-side columns (the figures of a goal on paper) are separate lines: a gap wider than a space splits one.
    let reach = 0;
    for (const word of words.sort((a, b) => a.page - b.page || a.top - b.top || a.x - b.x)) {
      const last = lines[lines.length - 1];
      if (last && last.page === word.page && Math.abs(last.top - word.top) < 2 && word.x - reach < 24) {
        last.text += ` ${word.text}`;
        last.bottom = Math.max(last.bottom, word.bottom);
        reach = word.right;
      } else {
        lines.push({ page: word.page, top: word.top, bottom: word.bottom, text: word.text });
        reach = word.right;
      }
    }
    return lines;
  }

  // Past months, every row with a label, a long figure that wraps, a planned figure and «cerrado».
  async function seedMonths(db: postgres.Sql, person: Person, name: string, months: number, unit: string) {
    const today = todayInZone();
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${name}, ${plusDays(60)}, ${unit}, ${unit},
              (date_trunc('month', ${today}::date) - (${months} || ' months')::interval + interval '3 days'))
      returning id
    `;
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      select ${person.id}, ${goal.id}, (date_trunc('month', ${today}::date) - (n || ' months')::interval)::date, 777
      from generate_series(1, ${months}) n
    `;
    return goal.id;
  }

  async function printTo(page: Page, file: string): Promise<Line[]> {
    await page.emulateMedia({ media: "print" });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    return printedLines(file);
  }

  const MONTH_LABEL = /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}$/;
  const LONG_UNIT = "capítulos del manual avanzado";

  test("on paper a month's row never breaks: its label, its figures and its estado land on one page", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const goalId = await seedMonths(db, person, `Meta larga ${stamp}`, 40, LONG_UNIT);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/exportar");
      await expect(page.getByRole("main").getByRole("heading", { name: `Meta larga ${stamp}`, exact: true })).toBeVisible();
      const lines = await printTo(page, resolve(process.cwd(), "private/export-pdf", `379-filas-${goalId}.pdf`));
      const pages = Math.max(...lines.map((line) => line.page));
      expect(pages, "the table crosses several pages").toBeGreaterThan(2);

      // Every row is one label, one «cerrado» and one planned figure («777»): a row cut by a
      // page leaves a page with more of one than of another.
      const closedLabels = new Set(
        Array.from({ length: 40 }, (_, i) => {
          const day = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
          day.setUTCMonth(day.getUTCMonth() - (i + 1));
          return new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric", timeZone: "UTC" })
            .format(day)
            .replace(" de ", " ");
        }),
      );
      const rowsOn = (n: number) => {
        const on = lines.filter((line) => line.page === n);
        const count = (test: (text: string) => boolean) => on.filter((line) => test(line.text)).length;
        return {
          labels: count((text) => closedLabels.has(text)),
          closed: on.flatMap((line) => line.text.split(" ")).filter((word) => word === "cerrado").length,
          planned: on.flatMap((line) => line.text.split(" ")).filter((word) => word === "777").length,
        };
      };
      let labelsTotal = 0;
      for (let n = 1; n <= pages; n += 1) {
        const found = rowsOn(n);
        labelsTotal += found.labels;
        expect(found.closed, `page ${n}: «cerrado» per label`).toBe(found.labels);
        expect(found.planned, `page ${n}: planned figure per label`).toBe(found.labels);
      }
      expect(labelsTotal).toBe(40);
    } finally {
      await context.close();
      await remove(db, person, [goalId]);
    }
  });

  // Fourteen goals of different lengths: the page boundaries fall at every height of a section.
  const SWEEP = [9, 4, 13, 6, 11, 3, 15, 8, 5, 12, 7, 10, 2, 14];

  async function sweepOnPaper(
    { person, browser, baseURL, db }: { person: Person; browser: Browser; baseURL: string | undefined; db: postgres.Sql },
    check: (lines: Line[], names: string[]) => void,
  ) {
    const stamp = Date.now();
    const goals = await Promise.all(
      SWEEP.map(async (months, i) => {
        const name = `Meta ${String.fromCharCode(65 + i)} ${stamp}`;
        return { name, id: await seedMonths(db, person, name, months, "minutos") };
      }),
    );
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/exportar");
      await expect(page.getByRole("main").getByText(goals[0].name, { exact: true }).first()).toBeVisible();
      const lines = await printTo(page, resolve(process.cwd(), "private/export-pdf", `379-rotulos-${stamp}.pdf`));
      expect(Math.max(...lines.map((line) => line.page)), "the report crosses several pages").toBeGreaterThan(2);
      check(
        lines,
        goals.map((goal) => goal.name),
      );
    } finally {
      await context.close();
      await remove(db, person, goals.map((goal) => goal.id));
    }
  }

  const SECTION_LABEL = /^(este mes · |hasta hoy$|fases$|tareas de |al terminar$)|· por mes · \d+ mes(es)?$/i;

  test("on paper a goal's heading and a section label are never the last line of a page", async ({ person, browser, baseURL, db }) => {
    await sweepOnPaper({ person, browser, baseURL, db }, (lines, names) => {
      const heading = new RegExp(`^(${names.join("|")})$`);
      let checked = 0;
      for (const [index, line] of lines.entries()) {
        if (!heading.test(line.text) && !SECTION_LABEL.test(line.text)) continue;
        checked += 1;
        expect(lines[index + 1]?.page, `«${line.text}» ends page ${line.page}`).toBe(line.page);
      }
      // A heading, «este mes», «hasta hoy» and «por mes» for each goal.
      expect(checked).toBe(names.length * 4);
    });
  });

  test("on paper a «por mes» label sits on the page of its first month", async ({ person, browser, baseURL, db }) => {
    await sweepOnPaper({ person, browser, baseURL, db }, (lines) => {
      let checked = 0;
      for (const [index, line] of lines.entries()) {
        if (!/· por mes · \d+ mes(es)?$/i.test(line.text)) continue;
        checked += 1;
        const firstRow = lines.slice(index + 1).find((later) => MONTH_LABEL.test(later.text));
        expect(firstRow?.page, `«${line.text}» is parted from its first month`).toBe(line.page);
      }
      expect(checked).toBe(SWEEP.length);
    });
  });
});

// RP-58: «Esta semana: <hecho> de <planeado>.» — the month's amount
// spread over the month's days, summed over the week's days inside the goal.

function firstOfMonth(day: string, offset: number): string {
  const date = civilDateToDate(`${day.slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
}

function daysInMonthOf(day: string): number {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();
}

// The rule written out for the seeded week, over exact integers: every month has
// 28 to 31 days, so scaling by their product keeps each day's share whole.
function plannedByRule(monthAmounts: Record<string, number>, openedOn: string, horizon: string): number {
  const scale = 28 * 29 * 30 * 31;
  const monday = civilDateToDate(todayInZone());
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  let scaled = 0;
  for (let i = 0; i < 7; i++) {
    const day = dateToCivilDate(monday);
    monday.setUTCDate(monday.getUTCDate() + 1);
    if (day < openedOn || day >= horizon) continue;
    const amount = monthAmounts[`${day.slice(0, 7)}-01`] ?? 0;
    scaled += amount * (scale / daysInMonthOf(day));
  }
  return Math.floor(scaled / scale);
}

function minutesText(total: number): string {
  const h = Math.floor(total / 60);
  const min = total % 60;
  if (h === 0) return `${min} min`;
  if (min === 0) return `${h} h`;
  return `${h} h ${String(min).padStart(2, "0")} min`;
}

async function seedWeek(
  db: postgres.Sql,
  person: Person,
  amount: number | null,
  span: { openedDaysAgo: number; horizonInDays: number } = { openedDaysAgo: 70, horizonInDays: 90 },
) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const today = todayInZone();
  const name = `Meta semana ${stamp}`;
  const horizon = plusDays(span.horizonInDays);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${horizon}, 'minutos', 'minutos', now() - make_interval(days => ${span.openedDaysAgo}))
    returning id
  `;
  const months = [-1, 0, 1].map((offset) => firstOfMonth(today, offset));
  if (amount !== null) {
    for (const month of months) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${month}::date, ${amount})
      `;
    }
  }
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Sesión ${stamp}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '70 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${commitment.id}, ${today}::date, 90)
  `;
  const openedOn = plusDays(-span.openedDaysAgo);
  return { goalId: goal.id, name, months, openedOn, horizon };
}

test.describe("the report's week says what was planned for it (RP-58)", () => {
  for (const width of [390, 1440] as const) {
    test(`at ${width} a goal at 12 h a month reads «Esta semana: <hecho> de <planeado>.» with both figures mono`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const seeded = await seedWeek(db, person, 720);
      const context = await browser.newContext({
        storageState: person.sessionFile,
        baseURL: baseURL!,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/exportar");
        const main = page.getByRole("main");
        await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();

        const planned = plannedByRule(
          Object.fromEntries(seeded.months.map((month) => [month, 720])),
          seeded.openedOn,
          seeded.horizon,
        );
        expect(planned).toBeGreaterThan(0);
        const line = main.getByText(/^Esta semana: /).locator("visible=true");
        await expect(line).toHaveCount(1);
        const text = ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim();
        expect(text).toBe(`Esta semana: 1 h 30 min de ${minutesText(planned)}.`);

        const fonts = await line.evaluate((node) => {
          const digits = [...node.querySelectorAll("span")].filter((span) => /\d/.test(span.textContent ?? ""));
          return {
            line: getComputedStyle(node).fontFamily,
            digits: digits.map((span) => getComputedStyle(span).fontFamily),
          };
        });
        expect(fonts.line).not.toMatch(/mono/i);
        // The done figure and the planned one, each a span of its own.
        expect(fonts.digits.length).toBeGreaterThanOrEqual(2);
        for (const family of fonts.digits) expect(family).toMatch(/mono/i);
        await expect(main.getByText(/de 0 min/)).toHaveCount(0);
      } finally {
        await context.close();
        await remove(db, person, [seeded.goalId]);
      }
    });
  }

  test("a goal with no amount reads the done figure alone", async ({ person, browser, baseURL, db }) => {
    const seeded = await seedWeek(db, person, null);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 390, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/exportar");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
      const line = main.getByText(/^Esta semana: /).locator("visible=true");
      await expect(line).toHaveCount(1);
      const text = ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim();
      expect(text).toBe("Esta semana: 1 h 30 min.");
      await expect(main.getByText(/ de 0 min/)).toHaveCount(0);
    } finally {
      await context.close();
      await remove(db, person, [seeded.goalId]);
    }
  });
});

// The week names its days when the goal does not fill it: it opened after Monday, ends before Sunday, or both.
// The seeded goal opens on this week's Tuesday and ends today, so each test skips the weekdays that cannot show its edge.
async function seedPartial(
  db: postgres.Sql,
  person: Person,
  edges: { opens: boolean; ends: boolean },
  measure: { unit: string; amount: number | null; fact: number } = { unit: "minutos", amount: 720, fact: 90 },
) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const today = todayInZone();
  const name = `Meta parcial ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${plusDays(edges.ends ? 1 : 90)}, ${measure.unit}, ${measure.unit},
      now() - make_interval(days => ${edges.opens ? weekday - 1 : 70}))
    returning id
  `;
  if (measure.amount !== null) {
    for (const offset of [-1, 0, 1]) {
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${firstOfMonth(today, offset)}::date, ${measure.amount})
      `;
    }
  }
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Sesión ${stamp}`}, 'daily', 'quantity', 1, ${measure.unit}, now() - interval '70 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${commitment.id}, ${today}::date, ${measure.fact})
  `;
  return { goalId: goal.id, name };
}

async function weekLine(browser: Browser, baseURL: string, person: Person, name: string) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width: 390, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name, exact: true })).toBeVisible();
    const line = main.getByText(/^Esta semana/).locator("visible=true");
    await expect(line).toHaveCount(1);
    return ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim();
  } finally {
    await context.close();
  }
}

test.describe("the report's week names the days the goal does not fill", () => {
  test("a goal opened this week after Monday reads «Esta semana, desde el <día>: X de Y.»", async ({
    person, browser, baseURL, db,
  }) => {
    test.skip(weekday < 1, "on Monday the goal opens on the week's first day");
    const seeded = await seedPartial(db, person, { opens: true, ends: false });
    try {
      const text = await weekLine(browser, baseURL!, person, seeded.name);
      expect(text).toMatch(/^Esta semana, desde el martes: 1 h 30 min de (\d+ h( \d+ min)?|\d+ min)\.$/);
    } finally {
      await remove(db, person, [seeded.goalId]);
    }
  });

  test("a goal that fills the week reads «Esta semana: X de Y.» with no day named", async ({
    person, browser, baseURL, db,
  }) => {
    const seeded = await seedWeek(db, person, 720);
    try {
      const text = await weekLine(browser, baseURL!, person, seeded.name);
      expect(text).toMatch(/^Esta semana: 1 h 30 min de .+\.$/);
      expect(text).not.toMatch(/desde|hasta| al /);
    } finally {
      await remove(db, person, [seeded.goalId]);
    }
  });

  test("a goal ending this week before Sunday reads «Esta semana, hasta el <día>: X de Y.»", async ({
    person, browser, baseURL, db,
  }) => {
    test.skip(weekday >= 6, "on Sunday the goal's last day is the week's last");
    const seeded = await seedPartial(db, person, { opens: false, ends: true });
    try {
      const text = await weekLine(browser, baseURL!, person, seeded.name);
      // On a Monday the goal's last day is also the week's first: one day, said as «el lunes».
      expect(text).toMatch(new RegExp(`^Esta semana, ${untilDay()}: 1 h 30 min de .+\\.$`));
    } finally {
      await remove(db, person, [seeded.goalId]);
    }
  });

  test("a goal that opens and ends inside the week reads «Esta semana, del martes al <día>: X de Y.»", async ({
    person, browser, baseURL, db,
  }) => {
    test.skip(weekday < 1 || weekday >= 6, "needs a Tuesday-to-Saturday today");
    const seeded = await seedPartial(db, person, { opens: true, ends: true });
    try {
      const text = await weekLine(browser, baseURL!, person, seeded.name);
      // On a Tuesday the goal's first and last day are one: said as «el martes», like Monday's «el lunes».
      const span = weekday === 1 ? "el martes" : `del martes al ${DAY_NAMES[weekday]}`;
      expect(text).toMatch(new RegExp(`^Esta semana, ${span}: 1 h 30 min de .+\\.$`));
    } finally {
      await remove(db, person, [seeded.goalId]);
    }
  });

  test("a goal that opens and ends the same day reads «Esta semana, el <día>: X de Y.», never «del … al …»", async ({
    person, browser, baseURL, db,
  }) => {
    const seeded = await seedWeek(db, person, 720, { openedDaysAgo: 0, horizonInDays: 1 });
    try {
      const text = await weekLine(browser, baseURL!, person, seeded.name);
      expect(text).toMatch(new RegExp(`^Esta semana, el ${DAY_NAMES[weekday]}: 1 h 30 min de .+\\.$`));
    } finally {
      await remove(db, person, [seeded.goalId]);
    }
  });

  test("a partial week with no planned amount reads «Esta semana, desde el <día>: 34 km.»", async ({
    person, browser, baseURL, db,
  }) => {
    test.skip(weekday < 1, "on Monday the goal opens on the week's first day");
    const seeded = await seedPartial(db, person, { opens: true, ends: false }, { unit: "km", amount: null, fact: 34 });
    try {
      const text = await weekLine(browser, baseURL!, person, seeded.name);
      expect(text).toBe("Esta semana, desde el martes: 34 km.");
    } finally {
      await remove(db, person, [seeded.goalId]);
    }
  });

  test("on paper the report prints no «Esta semana»", async ({ person, browser, baseURL, db }) => {
    const seeded = await seedWeek(db, person, 720);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 794, height: 1123 } });
    try {
      const page = await context.newPage();
      await page.goto("/exportar");
      await expect(page.getByRole("main").getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
      await page.emulateMedia({ media: "print" });
      const file = resolve(process.cwd(), "private/export-pdf", `804-week-${seeded.goalId}.pdf`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
      const flat = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
      expect(flat).toContain(seeded.name);
      expect(flat).not.toContain("Esta semana");
    } finally {
      await context.close();
      await remove(db, person, [seeded.goalId]);
    }
  });
});

// The week's planned figure stops at the goal's last day (RP-58), not at Sunday.
// Saturday and Sunday cannot show the difference.
const weekday = (civilDateToDate(todayInZone()).getUTCDay() + 6) % 7;
const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
// A goal ending today: «hasta el <día>», or «el lunes» alone when today opens the week.
const untilDay = () => (weekday === 0 ? `el ${DAY_NAMES[0]}` : `hasta el ${DAY_NAMES[weekday]}`);

test("a goal ending this week counts its planned figure up to its last day, not to Sunday (RP-58)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  test.skip(weekday >= 5, "on this weekday the goal's last day is the week's last");
  const seeded = await seedWeek(db, person, 720, { openedDaysAgo: 70, horizonInDays: 1 });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 390, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
    const amounts = Object.fromEntries(seeded.months.map((month) => [month, 720]));
    const planned = plannedByRule(amounts, seeded.openedOn, seeded.horizon);
    expect(planned).toBeLessThan(plannedByRule(amounts, seeded.openedOn, "9999-12-31"));
    const line = main.getByText(new RegExp(`^Esta semana, ${untilDay()}:`)).locator("visible=true");
    await expect(line).toHaveCount(1);
    const text = ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim();
    expect(text).toBe(`Esta semana, ${untilDay()}: 1 h 30 min de ${minutesText(planned)}.`);
  } finally {
    await context.close();
    await remove(db, person, [seeded.goalId]);
  }
});

test("a goal of one week still reads «Esta semana» and holds its weeks table (RP-49, RP-17)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const seeded = await seedWeek(db, person, null, { openedDaysAgo: 0, horizonInDays: 1 });
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 390, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
    await expect(main.getByText(/^Esta semana/).locator("visible=true")).toHaveCount(1);
    await expect(main.getByText("por semana", { exact: true })).toBeVisible();
    await expect(main.getByText("Ver la semana", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await remove(db, person, [seeded.goalId]);
  }
});

const MONTH_ROW = /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}/;

test("on a phone a month not yet started shows no figure of its own, a started one does (RP-32)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const seeded = await seedWeek(db, person, 720);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 390, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
    const rows = (await main.getByRole("listitem").allInnerTexts())
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter((text) => MONTH_ROW.test(text));
    const current = rows.findIndex((text) => text.includes("en curso"));
    expect(current).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(current + 1);
    // A month that began has what was reached; one that has not shows the dash.
    for (const text of rows.slice(0, current + 1)) expect(text).not.toContain("—");
    for (const text of rows.slice(current + 1)) expect(text).toContain("—");
  } finally {
    await context.close();
    await remove(db, person, [seeded.goalId]);
  }
});

test("the weeks table marks «en curso» on the current week's row and on no other (RP-17)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const seeded = await seedWeek(db, person, 720);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: seeded.name, exact: true })).toBeVisible();
    await main.locator("summary", { hasText: /^Ver las \d+ semanas$/ }).click();
    const rows = main.locator("table", { has: page.locator("caption", { hasText: /semanas$/ }) }).locator("tbody tr");
    const count = await rows.count();
    expect(count).toBeGreaterThan(2);
    // Opened 70 days ago, today is in its last week.
    await expect(rows.nth(count - 1)).toContainText("en curso");
    for (let index = 0; index < count - 1; index++) {
      await expect(rows.nth(index)).not.toContainText("en curso");
    }
  } finally {
    await context.close();
    await remove(db, person, [seeded.goalId]);
  }
});

// RP-70: with the months that have not started and carry no amount left off the paper, a «por mes» label
// still lands on the page of its first printed row and the page foot never ends on it.
test.describe("the paper's month tables without their empty months (RP-70)", () => {
  const NAMES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  const startOf = (offset: number) => firstOfMonth(`${todayInZone().slice(0, 7)}-01`, offset);

  test("on paper the «por mes» label of a goal with trailing empty months sits with its first month, and no empty month prints", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const ids: string[] = [];
    const names: string[] = [];
    // Each goal prints its past months and this one: past + 1 rows, and the label says so.
    const printed = new Map<string, number>();
    for (const [index, past] of [3, 1, 4, 2, 5, 1, 3, 2].entries()) {
      const name = `Vacíos ${stamp} n${index}`;
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
        values (${person.id}, ${name}, ${startOf(6)}::date, 'km', 'km',
                (${startOf(-past)}::date + interval '14 days' + interval '12 hours')::timestamptz)
        returning id
      `;
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount)
        values (${person.id}, ${goal.id}, ${startOf(0)}::date, 40)
      `;
      ids.push(goal.id);
      names.push(name);
      printed.set(name, past + 1);
    }
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 794, height: 1123 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/exportar");
      await expect(page.getByRole("main").getByText(names[0], { exact: true }).first()).toBeVisible();
      await page.emulateMedia({ media: "print" });
      const dir = resolve(process.cwd(), "private/export-pdf");
      mkdirSync(dir, { recursive: true });
      const file = resolve(dir, `725-etiqueta-${stamp}.pdf`);
      writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
      const count = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file], { encoding: "utf8" }))![1]);
      const pages = Array.from({ length: count }, (_, i) =>
        execFileSync("pdftotext", ["-layout", "-f", String(i + 1), "-l", String(i + 1), file, "-"], { encoding: "utf8" })
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      );
      const row = new RegExp(`^(${NAMES.join("|")}) \\d{4}\\b`);
      let rows = 0;
      for (const name of names) {
        const at = pages.findIndex((lines) => lines.some((line) => line.toLowerCase() === `${name} · por mes · ${printed.get(name)} meses`.toLowerCase()));
        expect(at, `${name}: label in the PDF`).toBeGreaterThanOrEqual(0);
        const lines = pages[at];
        const after = lines.slice(lines.findIndex((line) => line.toLowerCase() === `${name} · por mes · ${printed.get(name)} meses`.toLowerCase()) + 1);
        expect(after.some((line) => row.test(line)), `${name}: label on page ${at + 1}, its first row is not there`).toBe(true);
      }
      for (const lines of pages) rows += lines.filter((line) => row.test(line)).length;
      // Each goal: its past months and this one print; the five after it do not.
      const expected = [3, 1, 4, 2, 5, 1, 3, 2].reduce((sum, past) => sum + past + 1, 0);
      expect(rows).toBe(expected);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = any(${ids}) and user_id = ${person.id}`;
    }
  });
});
