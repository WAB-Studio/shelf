import { randomUUID } from "node:crypto";

import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { dayFromToday, noonFromToday } from "./reloj";

// `SemanaHoyEvidencia` and its dark face: inside today's
// column the evidence mark (soft fill, accent ring) must stand out from the
// column's own fill. It was lost: both were `--pulsar-accent-soft`. Written
// from the board and `docs/pulsar/DESIGN.md`'s token table, not from the CSS.
// Hex values are never repeated here: the tokens are the contract, read off
// the page the way a person's browser resolves them.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

// ICU's Spanish, never the catalogue's list the screen reads.
function longName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

const today = todayInZone();
const mondayToday = (civilDateToDate(today).getUTCDay() + 6) % 7 === 0;
// Yesterday, or on a Monday the previous week's Sunday: a day that is not today.
const otherDay = shift(today, -1);

const stamp = Date.now();
const EVIDENCE = `Buscar palabras ${stamp}`;
const DECLARED = `Tema técnico ${stamp}`;
const PENDING = `Pendiente ${stamp}`;

// 23:30 in Bogotá reaches the day only through the zone (docs/TRAPS.md).
const evening = (day: string) => new Date(`${day}T23:30:00-05:00`);

async function seed(db: postgres.Sql, person: Person) {
  const horizon = dayFromToday(90);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta hoy evidencia ${stamp}`}, ${horizon}, ${noonFromToday(-20)})
    returning id
  `;
  const commitment = async (name: string, kind: "tap" | "evidence") => {
    const [row] =
      kind === "evidence"
        ? await db<{ id: string }[]>`
            insert into goals.commitments
              (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
            values (${person.id}, ${goal.id}, ${name}, 'daily', 'evidence',
              (select id from goals.evidence_sources where key = 'reading_lookups'), 1, ${noonFromToday(-20)})
            returning id`
        : await db<{ id: string }[]>`
            insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
            values (${person.id}, ${goal.id}, ${name}, 'daily', 'tap', ${noonFromToday(-20)})
            returning id`;
    return row.id;
  };
  await commitment(EVIDENCE, "evidence");
  const declaredId = await commitment(DECLARED, "tap");
  await commitment(PENDING, "tap");
  await db`insert into goals.facts (user_id, commitment_id, day) values (${person.id}, ${declaredId}, ${today})`;
  const deviceId = randomUUID();
  let local = 0;
  for (const day of [today, otherDay]) {
    local += 1;
    await db`insert into reading.lookups
      (user_id, device_id, local_id, at, text, normalised, kind, outcome, headword, rule, senses, translation, dictionary_ready, origin, record_schema)
      values (${person.id}, ${deviceId}, ${local}, ${evening(day)}, 'evidencia', 'evidencia', 'word', 'miss', null, null, 0, null, true, null, 2)`;
  }
  return deviceId;
}

type Looks = { dot: string; ring: string; cell: string; own: string };

// What the browser resolves a token to, on the page's current colour scheme.
async function tokens(page: Page) {
  return page.evaluate(() => {
    const resolve = (property: "color" | "backgroundColor", token: string) => {
      const probe = document.createElement("i");
      probe.style[property] = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    return {
      accent: resolve("color", "--pulsar-accent"),
      soft: resolve("backgroundColor", "--pulsar-accent-soft"),
      quiet: resolve("color", "--pulsar-quiet"),
      raised: resolve("backgroundColor", "--pulsar-raised"),
      today: resolve("backgroundColor", "--pulsar-today"),
    };
  });
}

// The mark's own fill and stroke, and the fill of the nearest ancestor that
// paints one: the mark's cell in the table and in the phone's list alike.
async function looks(mark: Locator): Promise<Looks> {
  return mark.evaluate((el) => {
    const dot = getComputedStyle(el);
    let cell = el.parentElement;
    while (cell) {
      const bg = getComputedStyle(cell).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break;
      cell = cell.parentElement;
    }
    return {
      own: el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : "rgba(0, 0, 0, 0)",
      dot: dot.backgroundColor,
      ring: `${dot.boxShadow}|${dot.borderTopColor}:${dot.borderTopWidth}`,
      cell: cell ? getComputedStyle(cell).backgroundColor : "rgba(0, 0, 0, 0)",
    };
  });
}

const alpha = (color: string) => (color.startsWith("rgba") ? Number(color.split(",")[3].replace(")", "")) : 1);

async function open(browser: Browser, baseURL: string | undefined, person: Person, width: number, scheme: "light" | "dark") {
  const context = await browser.newContext({
    baseURL,
    storageState: person.sessionFile,
    viewport: { width, height: 900 },
    hasTouch: width < 1024,
    colorScheme: scheme,
  });
  return { context, page: await context.newPage() };
}

function markOf(page: Page, name: string, day: string): Locator {
  return page.getByRole("img", { name: new RegExp(`^${name}, ${longName(day)}: `) });
}

for (const scheme of ["light", "dark"] as const) {
  for (const width of [360, 1280]) {
    const where = `${scheme}, ${width}px`;

    test(`the evidence mark in today's cell is not the cell's own fill, and keeps its soft fill and accent ring (${where})`, async ({
      browser,
      baseURL,
      db,
      person,
    }) => {
      const deviceId = await seed(db, person);
      const { context, page } = await open(browser, baseURL, person, width, scheme);
      try {
        await page.goto("/semana");
        const mark = markOf(page, EVIDENCE, today);
        await expect(mark).toHaveAttribute("data-state", "evidence");
        const token = await tokens(page);
        const seen = await looks(mark);

        // The defect: the mark and the column shared one fill and the mark vanished.
        expect(seen.dot).not.toBe(seen.cell);
        // Today stays a fill the column draws, never removed to escape the clash.
        expect(alpha(seen.cell)).toBeGreaterThan(0);
        // The desktop column is tinted, the phone's fold raises; each scheme its own token.
        expect(seen.cell).toBe(width >= 1024 ? token.today : token.raised);
        // The board's treatment: soft fill and an accent stroke, not a new hue.
        expect(seen.dot).toBe(token.soft);
        expect(seen.ring).toContain(token.accent);
      } finally {
        await context.close();
        await db`delete from reading.lookups where user_id = ${person.id} and device_id = ${deviceId}`;
      }
    });

    test(`the evidence mark on another day keeps its soft fill on the column's own ground (${where})`, async ({
      browser,
      baseURL,
      db,
      person,
    }) => {
      const deviceId = await seed(db, person);
      const { context, page } = await open(browser, baseURL, person, width, scheme);
      try {
        await page.goto(mondayToday ? `/semana?semana=${shift(today, -7)}` : "/semana");
        const mark = markOf(page, EVIDENCE, otherDay);
        await expect(mark).toHaveAttribute("data-state", "evidence");
        const token = await tokens(page);
        const seen = await looks(mark);

        expect(seen.dot).toBe(token.soft);
        expect(seen.ring).toContain(token.accent);
        // Off today the mark's own cell paints nothing: only today is a fill.
        expect(alpha(seen.own)).toBe(0);
      } finally {
        await context.close();
        await db`delete from reading.lookups where user_id = ${person.id} and device_id = ${deviceId}`;
      }
    });

    test(`the declared and the pending marks in today's cell keep their own treatment (${where})`, async ({
      browser,
      baseURL,
      db,
      person,
    }) => {
      const deviceId = await seed(db, person);
      const { context, page } = await open(browser, baseURL, person, width, scheme);
      try {
        await page.goto("/semana");
        const declared = markOf(page, DECLARED, today);
        const pending = markOf(page, PENDING, today);
        await expect(declared).toHaveAttribute("data-state", "declared");
        await expect(pending).toHaveAttribute("data-state", "empty");
        const token = await tokens(page);

        // Declared: the accent filled, no soft fill and no stroke of its own.
        const filled = await looks(declared);
        expect(filled.dot).toBe(token.accent);
        expect(filled.dot).not.toBe(filled.cell);

        // Pending: a quiet stroke and no fill.
        const hollow = await looks(pending);
        expect(alpha(hollow.dot)).toBe(0);
        expect(hollow.ring).toContain(token.quiet);
      } finally {
        await context.close();
        await db`delete from reading.lookups where user_id = ${person.id} and device_id = ${deviceId}`;
      }
    });
  }
}
