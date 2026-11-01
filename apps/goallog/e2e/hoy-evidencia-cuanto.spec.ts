import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, visit, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import sources from "../messages/es/sources.json";
import { boxOf } from "./box";

// RP-08, RP-09, board `HoyDia`: an evidence row's one meta line says how much
// it asks until it is met, and what it got plus its source once met. Unmet it
// is named by who notes it, and the row has no tap (RP-05).

const SOURCE = sources.readingLookups;
// An evidence row reads automatic (DESIGN «An evidence row reads automatic»): who notes it, then what it asks.
const NOTED = `lo anota el ${SOURCE}`;

type Seed = { goalId: string; name: string; deviceId: string; commitmentId: string };

// 23:30 in Bogotá is already tomorrow in UTC: the lookup is today's only through the zone.
function eveningInBogota(day: string, minuteOffset = 0): Date {
  return new Date(new Date(`${day}T23:30:00-05:00`).getTime() - minuteOffset * 60_000);
}

async function seed(
  db: postgres.Sql,
  person: Person,
  label: string,
  threshold: number,
  lookups: number,
  nameLength = 0,
): Promise<Seed> {
  const stamp = Date.now();
  const name = `Buscar ${label} ${stamp}${"x".repeat(nameLength)}`;
  const today = todayInZone();
  const horizon = civilDateToDate(today);
  horizon.setUTCDate(horizon.getUTCDate() + 90);
  const deviceId = randomUUID();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta ${label} ${stamp}`}, ${dateToCivilDate(horizon)}, now() - interval '20 days')
    returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
    values (
      ${person.id}, ${goal.id}, ${name}, 'daily', 'evidence',
      (select id from goals.evidence_sources where key = 'reading_lookups'), ${threshold},
      now() - interval '20 days'
    )
    returning id
  `;
  for (let local = 1; local <= lookups; local++) {
    await db`insert into reading.lookups
      (user_id, device_id, local_id, at, text, normalised, kind, outcome, headword, rule, senses, translation, dictionary_ready, origin, record_schema)
      values (${person.id}, ${deviceId}, ${local}, ${eveningInBogota(today, local)}, 'evidencia', 'evidencia', 'word', 'miss', null, null, 0, null, true, null, 2)`;
  }
  return { goalId: goal.id, name, deviceId, commitmentId: commitment.id };
}

async function clean(db: postgres.Sql, person: Person, seeded: Seed): Promise<void> {
  await db`delete from reading.lookups where user_id = ${person.id} and device_id = ${seeded.deviceId}`;
  await db`delete from goals.goals where id = ${seeded.goalId} and user_id = ${person.id}`;
}

// Everything the row draws besides its name, whitespace folded: the meta line.
// An evidence row is text, never a control (DESIGN «An act that cannot be done is plain text»): a block holding its mark and its name.
function rowOf(page: Page, name: string) {
  return page.locator("div:has([data-state])", { hasText: name }).last();
}

async function metaOf(page: Page, name: string): Promise<string> {
  const row = rowOf(page, name);
  await expect(row).toBeVisible();
  const text = await row.innerText();
  return text.replace(name, "").replace(/\s+/g, " ").trim();
}

async function open(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  person: Person,
  width: number,
) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: 800 },
    hasTouch: true,
  });
  const page = await context.newPage();
  return { context, page };
}

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    test(`nothing searched yet: the row says what it asks, never the source (empty)`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const seeded = await seed(db, person, "vacío", 1, 0);
      const { context, page } = await open(browser, baseURL!, person, width);
      try {
        await visit(page, "/");
        expect(await metaOf(page, seeded.name)).toBe(`${NOTED} · 1 búsqueda`);
        const row = rowOf(page, seeded.name);
        await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "empty");
        await expect(row, "named as the one that notes it, not as a met source").not.toContainText(`· ${SOURCE}`);
      } finally {
        await context.close();
        await clean(db, person, seeded);
      }
    });

    test(`below the threshold: it still asks the whole threshold and does not name the source (partial)`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const seeded = await seed(db, person, "parte", 3, 2);
      const { context, page } = await open(browser, baseURL!, person, width);
      try {
        await visit(page, "/");
        expect(await metaOf(page, seeded.name)).toBe(`${NOTED} · 3 búsquedas`);
        const row = rowOf(page, seeded.name);
        await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "empty");
        await expect(row, "named as the one that notes it, not as a met source").not.toContainText(`· ${SOURCE}`);
      } finally {
        await context.close();
        await clean(db, person, seeded);
      }
    });

    test(`met: it says what it got, not what it asked, then the source, and the row takes no tap`, async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const seeded = await seed(db, person, "hecho", 1, 3);
      const { context, page } = await open(browser, baseURL!, person, width);
      try {
        await visit(page, "/");
        expect(await metaOf(page, seeded.name)).toBe(`3 búsquedas · ${SOURCE}`);
        const row = rowOf(page, seeded.name);
        await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "evidence");
        await expect(page.getByRole("button", { name: new RegExp(seeded.name) }), "no control for the row").toHaveCount(0);

        // A real pointer press on the row's box: it opens nothing and writes nothing (RP-05).
        const box = (await boxOf(row));
        const url = page.url();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(page.url()).toBe(url);
        await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "evidence");
        const [facts] = await db<{ count: number }[]>`
          select count(*)::int as count from goals.facts where commitment_id = ${seeded.commitmentId}
        `;
        expect(facts.count).toBe(0);
      } finally {
        await context.close();
        await clean(db, person, seeded);
      }
    });
  });
}

test("at 360 the longest evidence line fits: a long name, a three-digit count, the source, no overflow", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const seeded = await seed(db, person, "ancho", 120, 120, 60);
  const { context, page } = await open(browser, baseURL!, person, 360);
  try {
    await visit(page, "/");
    expect(await metaOf(page, seeded.name)).toBe(`120 búsquedas · ${SOURCE}`);
    const row = rowOf(page, seeded.name);
    const fits = await row.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const inner = [...el.querySelectorAll("*")].map((child) => child.getBoundingClientRect());
      return {
        rowRight: box.right,
        viewport: window.innerWidth,
        pageScroll: document.documentElement.scrollWidth,
        overflowingChild: inner.some((r) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1)),
        ownScroll: el.scrollWidth - el.clientWidth,
      };
    });
    expect(fits.rowRight).toBeLessThanOrEqual(fits.viewport);
    expect(fits.pageScroll).toBeLessThanOrEqual(fits.viewport);
    expect(fits.overflowingChild).toBe(false);
    expect(fits.ownScroll).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
    await clean(db, person, seeded);
  }
});

// The goal's commitment list reads the same source unit as a bare noun and
// draws its own number before it: the unit message must never carry one.
test("the goal's commitment line reads «3 búsquedas · diccionario» for threshold 3", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const seeded = await seed(db, person, "meta", 3, 0);
  const { context, page } = await open(browser, baseURL!, person, 390);
  try {
    await visit(page, `/metas/${seeded.goalId}`);
    // The innermost span that holds both the figure and the source.
    const line = page.locator("span", { hasText: SOURCE }).last();
    await expect(line).toBeVisible();
    expect((await line.innerText()).replace(/\s+/g, " ").trim()).toBe(`3 búsquedas · ${SOURCE}`);
  } finally {
    await context.close();
    await clean(db, person, seeded);
  }
});
