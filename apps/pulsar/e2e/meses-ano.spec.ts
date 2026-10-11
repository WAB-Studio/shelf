import type { Page } from "@playwright/test";
import { test as base, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Module 806 (RP-32, RP-28), `MesesConAño` option B: no month of «Por mes» and
// no month title reads without its year; the sentences that name a month beside
// its title keep the month alone; a future month with no amount does not claim
// «planeado». Every expected string is built from the clock, never a literal year.

// `page` is the seeded person's own: the default context is another identity.
const test_ = base.extend<{ page: Page }>({
  page: async ({ browser, baseURL, person }, provide) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    await provide(await context.newPage());
    await context.close();
  },
});
const NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const name = (month: string) => NAMES[Number(month.slice(5, 7)) - 1];
const withYear = (month: string) => `${name(month)} ${month.slice(0, 4)}`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const seg = (month: string) => month.slice(0, 7);

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));

// The goal's 16 months, this one first: it crosses a year boundary, and its
// 13th month carries the first one's name in the next year.
const span: string[] = [thisMonth];
while (span.length < 16) span.push(nextMonth(span[span.length - 1]));
const horizon = nextMonth(span[15]);

type Db = import("postgres").Sql;

async function seedGoal(
  db: Db,
  personId: string,
  label: string,
  options: { unit?: "minutos" | null; rhythm?: number | null; openedOn?: string; archived?: boolean } = {},
) {
  const unit = options.unit === undefined ? "minutos" : options.unit;
  const opened = options.openedOn ?? thisMonth;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at, archived_at)
    values (
      ${personId}, ${label}, ${horizon}::date,
      ${unit === null ? null : "estudio"}, ${unit}, ${options.rhythm ?? null},
      (${opened}::date + 0) + time '12:00' at time zone 'UTC',
      ${options.archived ? db`now()` : null}
    )
    returning id`;
  return goal.id;
}

async function budget(db: Db, personId: string, goalId: string, month: string, amount: number) {
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${personId}, ${goalId}, ${month}::date, ${amount})`;
}

// A time-measured goal with an amount in some months and none in the rest.
async function seedMeasured(db: Db, personId: string, label: string) {
  const goalId = await seedGoal(db, personId, label);
  await budget(db, personId, goalId, span[0], 270);
  await budget(db, personId, goalId, span[1], 600);
  await budget(db, personId, goalId, span[12], 720);
  return goalId;
}

const rowsOf = (page: Page) => page.locator("main ol li:visible");

// The label's text, without the state line under it.
async function labelsOf(page: Page): Promise<string[]> {
  return rowsOf(page).evaluateAll((items) =>
    items.map((item) => {
      const label = item.querySelector<HTMLElement>('[class*="stackLabel"]');
      const walker = document.createTreeWalker(label!, NodeFilter.SHOW_TEXT);
      return (walker.nextNode()?.textContent ?? "").trim();
    }),
  );
}

async function blockOf(page: Page) {
  const phrase = page.getByText("sin monto planeado", { exact: true });
  await expect(phrase).toBeVisible();
  return phrase.locator("xpath=../..");
}

// The section label is set in capitals by CSS; `innerText` returns them so.
const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

test_("«Por mes» of a goal measured in time: every row reads «<mes> <año>», and the two equal months of different years are different texts (RP-32)", async ({
  person,
  page,
  db,
}) => {
  const goalId = await seedMeasured(db, person.id, `Meta con año ${Date.now()}`);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses`);
  await expect(rowsOf(page)).toHaveCount(16);

  const labels = await labelsOf(page);
  expect(labels).toEqual(span.map(withYear));
  // Month 13 shares month 0's name a year later.
  expect(name(span[12])).toBe(name(span[0]));
  expect(labels[12]).not.toBe(labels[0]);
  expect(new Set(labels).size).toBe(16);
  // The state stays under the label.
  await expect(rowsOf(page).nth(0)).toContainText("en curso");
  await expect(rowsOf(page).nth(1)).toContainText("planeado");
});

test_("«Por mes» of a goal that measures nothing: the tasks table reads «<mes> <año>» in every row (RP-32)", async ({
  person,
  page,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta sin medida con año ${Date.now()}`, { unit: null });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses`);
  await expect(rowsOf(page)).toHaveCount(16);
  const labels = await labelsOf(page);
  expect(labels).toEqual(span.map(withYear));
  expect(labels[12]).not.toBe(labels[0]);
  await expect(rowsOf(page).nth(0)).toContainText("en curso");
});

test_("the month page's title carries the year of its month, not the year of today (RP-32)", async ({ person, page, db }) => {
  const goalId = await seedMeasured(db, person.id, `Meta título con año ${Date.now()}`);
  // Month 14: always a year after the one the goal opened in.
  const month = span[14];
  expect(month.slice(0, 4)).not.toBe(thisMonth.slice(0, 4));
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses/${seg(month)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(capital(withYear(month)));
});

test_("from 1024 the month open beside the list is headed «<Mes> <año>» in its h2 (RP-32)", async ({ person, page, db }) => {
  const goalId = await seedMeasured(db, person.id, `Meta h2 con año ${Date.now()}`);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`/metas/${goalId}/meses`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Por mes");
  await expect(page.getByRole("heading", { level: 2, name: capital(withYear(thisMonth)), exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: capital(name(thisMonth)), exact: true })).toHaveCount(0);
});

test_("sentences that name a month beside its title keep the month alone (RP-28, RP-32)", async ({ person, page, db }) => {
  await page.setViewportSize({ width: 360, height: 740 });

  // A goal with no amount anywhere offers «Planear <mes>» and the sheet asks «¿Cuánto en <mes>?».
  const bare = await seedGoal(db, person.id, `Meta frases ${Date.now()}`);
  await page.goto(`/metas/${bare}/meses`);
  await expect(page.getByRole("link", { name: `Planear ${name(thisMonth)}`, exact: true })).toBeVisible();
  await page.goto(`/metas/${bare}/meses?planear=${seg(span[1])}`);
  await expect(page.getByRole("dialog").getByRole("heading", { name: `¿Cuánto en ${name(span[1])}?`, exact: true })).toBeVisible();

  // A month with a task closes its list with «Otra tarea de <mes>».
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${bare}, ${`Tarea frases ${Date.now()}`}, ${thisMonth}::date, 30)`;
  await page.goto(`/metas/${bare}/meses/${seg(thisMonth)}`);
  await expect(page.getByRole("link", { name: `Otra tarea de ${name(thisMonth)}`, exact: true })).toBeVisible();
});

for (const width of [360, 1024]) {
  test_(`at ${width}: no overflow, every row 56 px, and no label wraps (the label column is wide enough for «septiembre 2026») (RP-32)`, async ({
    person,
    page,
    db,
  }) => {
    const goalId = await seedMeasured(db, person.id, `Meta sin salto ${width} ${Date.now()}`);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/metas/${goalId}/meses`);
    await expect(rowsOf(page)).toHaveCount(16);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // The tap target: the row's link, without the rule drawn under the row.
    const heights = await rowsOf(page).evaluateAll((items) =>
      items.map((item) => Math.round(item.querySelector("a")!.getBoundingClientRect().height)),
    );
    expect(heights).toEqual(Array(16).fill(56));

    // Lines the label's own text occupies: one per row, whatever the month.
    const lines = await rowsOf(page).evaluateAll((items) =>
      items.map((item) => {
        const label = item.querySelector<HTMLElement>('[class*="stackLabel"]')!;
        const node = document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange();
        range.selectNodeContents(node);
        return { text: node.textContent, lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size };
      }),
    );
    expect(lines.map((line) => line.lines)).toEqual(Array(16).fill(1));
    expect(lines.map((line) => line.text?.trim())).toEqual(span.map(withYear));
  });
}

test_("a future month in time with no amount: «sin monto planeado» alone, no other «planeado», no «0 min» (RP-32)", async ({
  person,
  page,
  db,
}) => {
  const goalId = await seedMeasured(db, person.id, `Meta futuro sin monto ${Date.now()}`);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses/${seg(span[2])}`);
  const text = squash(await (await blockOf(page)).innerText());
  expect(text).toBe("sin monto planeado");
});

test_("a future month in time with the goal's rhythm: «planeado», «0 min» and «de 12 h» stay (RP-50)", async ({ person, page, db }) => {
  const goalId = await seedGoal(db, person.id, `Meta futuro con ritmo ${Date.now()}`, { rhythm: 720 });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses/${seg(span[2])}`);
  const phrase = page.getByRole("link", { name: "de 12 h", exact: true });
  await expect(phrase).toBeVisible();
  const text = squash(await phrase.locator("xpath=../..").innerText());
  expect(text).toContain("planeado");
  expect(text).toContain("0 min");
  expect(text).toContain("de 12 h");
  expect(text).not.toContain("sin monto");
});

test_("the current month in time with no amount keeps «este mes», its figure and «sin monto planeado» (RP-32)", async ({
  person,
  page,
  db,
}) => {
  const goalId = await seedGoal(db, person.id, `Meta mes actual sin monto ${Date.now()}`);
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${`Hecha ${Date.now()}`}, ${thisMonth}::date, 270) returning id`;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goalId}, ${done.id}, ${todayInZone()}::date)`;
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
  const text = squash(await (await blockOf(page)).innerText());
  expect(text).toContain("este mes");
  expect(text).toContain("4 h 30 min");
  expect(text).toContain("sin monto planeado");
});

test_("a closed month in time with no amount keeps «cerrado» and its figure (RP-32)", async ({ person, page, db }) => {
  const goalId = await seedGoal(db, person.id, `Meta cerrado sin monto ${Date.now()}`, { openedOn: lastMonth });
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goalId}, ${`Hecha ${Date.now()}`}, ${lastMonth}::date, 100) returning id`;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goalId}, ${done.id}, ${lastMonth}::date + 14)`;
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`/metas/${goalId}/meses/${seg(lastMonth)}`);
  const text = squash(await (await blockOf(page)).innerText());
  expect(text).toContain("cerrado");
  expect(text).toContain("1 h 40 min");
});

test_("an archived goal's future month with no amount: «sin monto planeado» is text, not a link; an open goal's is a link (RP-32)", async ({
  person,
  page,
  db,
}) => {
  const open = await seedMeasured(db, person.id, `Meta abierta ${Date.now()}`);
  const archived = await seedMeasured(db, person.id, `Meta archivada ${Date.now()}`);
  await db`update goals.goals set archived_at = now() where id = ${archived}`;
  await page.setViewportSize({ width: 360, height: 740 });

  await page.goto(`/metas/${open}/meses/${seg(span[2])}`);
  await expect(page.getByRole("link", { name: "sin monto planeado", exact: true })).toHaveCount(1);

  await page.goto(`/metas/${archived}/meses/${seg(span[2])}`);
  const block = await blockOf(page);
  await expect(page.getByRole("link", { name: "sin monto planeado", exact: true })).toHaveCount(0);
  expect(squash(await block.innerText())).toBe("sin monto planeado");
});
