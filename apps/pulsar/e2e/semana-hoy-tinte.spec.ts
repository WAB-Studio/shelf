import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, settled, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";

// `SemanaHoyTinte` (approved 2026-10-09): at 1440 the whole today column,
// header to foot, is a tint of its own (`--pulsar-today`) that is neither the
// card's colour nor the evidence fill; the phone's fold is unchanged. Written
// from the board's numbers and the token table, not from the CSS.

// The approved tint, per face.
const TINT = { light: "rgb(227, 232, 238)", dark: "rgb(30, 37, 44)" } as const;

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
// A day of today's own week that is not today.
const otherDay = mondayToday ? shift(today, 1) : shift(today, -1);
// A day to come draws no evidence, so on a Monday the week has no other day with one: today's own mark stands in.
const evidenceDay = mondayToday ? today : otherDay;

const stamp = Date.now();
const EVIDENCE = `Buscar palabras ${stamp}`;
const PENDING = `Pendiente ${stamp}`;

// 23:30 in Bogotá reaches the day only through the zone (docs/TRAPS.md).
const evening = (day: string) => new Date(`${day}T23:30:00-05:00`);

async function seed(db: postgres.Sql, person: Person, extraRows = 0): Promise<void> {
  const horizon = dateToCivilDate(new Date(Date.now() + 90 * 86_400_000));
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta hoy tinte ${stamp}`}, ${horizon}, now() - interval '20 days')
    returning id
  `;
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, source_id, threshold, created_at)
    values (${person.id}, ${goal.id}, ${EVIDENCE}, 'daily', 'evidence',
      (select id from goals.evidence_sources where key = 'reading_lookups'), 1, now() - interval '20 days')
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, ${PENDING}, 'daily', 'tap', now() - interval '20 days')
  `;
  if (extraRows > 0) {
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      select ${person.id}, ${goal.id}, 'Relleno ' || n || ' ' || ${stamp}::text, 'daily', 'tap', now() - interval '20 days'
      from generate_series(1, ${extraRows}) n
    `;
  }
  for (const day of [today, otherDay]) {
    await db`insert into reading.lookups
      (user_id, device_id, local_id, at, text, normalised, kind, outcome, headword, rule, senses, translation, dictionary_ready, origin, record_schema)
      values (${person.id}, gen_random_uuid(), ${day === today ? 1 : 2}, ${evening(day)}, 'evidencia', 'evidencia', 'word', 'miss', null, null, 0, null, true, null, 2)`;
  }
}

async function cleanLookups(db: postgres.Sql, person: Person): Promise<void> {
  await db`delete from reading.lookups where user_id = ${person.id}`;
}

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
  return page.locator("table").getByRole("img", { name: new RegExp(`^${name}, ${longName(day)}: `) });
}

// What the browser resolves a token to on the page's current face.
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
      today: resolve("backgroundColor", "--pulsar-today"),
      raised: resolve("backgroundColor", "--pulsar-raised"),
      soft: resolve("backgroundColor", "--pulsar-accent-soft"),
      accent: resolve("color", "--pulsar-accent"),
      ink: resolve("color", "--pulsar-ink"),
      muted: resolve("color", "--pulsar-muted"),
    };
  });
}

function rgb(color: string): [number, number, number] {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`not a colour: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const alpha = (color: string) => (color.startsWith("rgba") ? Number(color.split(",")[3].replace(")", "")) : 1);

function paint(el: Element) {
  return getComputedStyle(el).backgroundColor;
}

// The cell, and the header and foot cells of its column.
async function column(mark: Locator) {
  return mark.evaluate((el) => {
    const cell = el.closest("td")!;
    const table = cell.closest("table")!;
    const index = cell.cellIndex;
    const bg = (node: Element | undefined | null) => (node ? getComputedStyle(node).backgroundColor : "missing");
    const foot = table.querySelector("tfoot tr")?.children[index] ?? null;
    return {
      cell: bg(cell),
      foot: bg(foot),
      footColor: foot ? getComputedStyle(foot).color : "missing",
      footText: foot?.textContent ?? "",
    };
  });
}

for (const scheme of ["light", "dark"] as const) {
  const where = `${scheme}, 1440px`;

  test(`today's column is a tint of its own: not the card's, not another day's, the approved one (${where})`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await seed(db, person);
    const { context, page } = await open(browser, baseURL, person, 1440, scheme);
    try {
      await page.goto("/semana");
      const pending = markOf(page, PENDING, today);
      await expect(pending).toHaveAttribute("data-state", "empty");
      const token = await tokens(page);
      const here = await column(pending);
      const other = await column(markOf(page, PENDING, otherDay));

      // The token exists and is the approved colour on this face.
      expect(token.today).toBe(TINT[scheme]);
      // The defect: the column was the card's colour and vanished.
      expect(here.cell).not.toBe(token.raised);
      expect(here.cell).toBe(token.today);
      // Another day's cell is not the tint.
      expect(here.cell).not.toBe(other.cell);
      // The column is one band down to its foot.
      expect(here.foot).toBe(token.today);
    } finally {
      await context.close();
      await cleanLookups(db, person);
    }
  });

  test(`the tint is not the evidence fill (${where})`, async ({ browser, baseURL, db, person }) => {
    await seed(db, person);
    const { context, page } = await open(browser, baseURL, person, 1440, scheme);
    try {
      await page.goto("/semana");
      const evidence = markOf(page, EVIDENCE, evidenceDay);
      await expect(evidence).toHaveAttribute("data-state", "evidence");
      const token = await tokens(page);
      const dot = await evidence.evaluate(paint);
      const todayCell = await column(markOf(page, PENDING, today));

      expect(dot).toBe(token.soft);
      expect(todayCell.cell).toBe(token.today);
      expect(alpha(token.today)).toBe(1);
      expect(todayCell.cell).not.toBe(dot);
      expect(token.today).not.toBe(token.soft);
    } finally {
      await context.close();
      await cleanLookups(db, person);
    }
  });

  test(`an evidence mark seeded today keeps the soft fill and accent ring over the tint (${where})`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await seed(db, person);
    const { context, page } = await open(browser, baseURL, person, 1440, scheme);
    try {
      await page.goto("/semana");
      const mark = markOf(page, EVIDENCE, today);
      await expect(mark).toHaveAttribute("data-state", "evidence");
      const token = await tokens(page);
      const seen = await mark.evaluate((el) => {
        const style = getComputedStyle(el);
        return { dot: style.backgroundColor, ring: style.boxShadow, cell: getComputedStyle(el.closest("td")!).backgroundColor };
      });

      expect(seen.dot).toBe(token.soft);
      expect(seen.ring).toContain(token.accent);
      expect(seen.cell).toBe(token.today);
      expect(seen.dot).not.toBe(seen.cell);
    } finally {
      await context.close();
      await cleanLookups(db, person);
    }
  });

  test(`ink and the muted text read over the tint at 4.5:1 or more (${where})`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await seed(db, person);
    const { context, page } = await open(browser, baseURL, person, 1440, scheme);
    try {
      await page.goto("/semana");
      const pending = markOf(page, PENDING, today);
      await expect(pending).toHaveAttribute("data-state", "empty");
      const token = await tokens(page);
      const here = await column(pending);

      // Measured over what is really painted behind the text.
      expect(alpha(here.cell)).toBe(1);
      expect(here.cell).toBe(token.today);
      expect(ratio(token.ink, here.cell)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(token.muted, here.cell)).toBeGreaterThanOrEqual(4.5);
      // The foot's own muted text, as drawn.
      expect(here.footText).not.toBe("");
      expect(ratio(here.footColor, here.foot)).toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.close();
      await cleanLookups(db, person);
    }
  });

  test(`today's header is opaque and sticky: the rows scrolling under never show through (${where})`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    await seed(db, person, 40);
    const { context, page } = await open(browser, baseURL, person, 1440, scheme);
    try {
      await page.goto("/semana");
      const pending = markOf(page, PENDING, today);
      await expect(pending).toHaveAttribute("data-state", "empty");
      const token = await tokens(page);
      const header = page.locator("table thead tr > *").nth(await pending.evaluate((el) => el.closest("td")!.cellIndex));

      await page.locator("table tfoot").scrollIntoViewIfNeeded();
      const seen = await header.evaluate((el) => {
        const style = getComputedStyle(el);
        // The top layer: a gradient over the colour, or the colour alone.
        const gradient = style.backgroundImage.match(/rgba?\([^)]*\)/);
        return {
          position: style.position,
          top: el.getBoundingClientRect().top,
          layer: gradient ? gradient[0] : style.backgroundColor,
          image: style.backgroundImage,
          color: style.backgroundColor,
        };
      });

      expect(seen.position).toBe("sticky");
      // Held at the top of the viewport after the page scrolled a long way.
      expect(seen.top).toBeGreaterThanOrEqual(0);
      expect(seen.top).toBeLessThan(60);
      // Opaque, and the column's own tint, never the card's.
      expect(alpha(seen.layer)).toBe(1);
      expect(seen.layer).toBe(token.today);
      expect(seen.layer).not.toBe(token.raised);
      // The gradient trick must hold: `.head`'s background-color outranks `.today`'s fill.
      expect(seen.image).toContain("linear-gradient");
    } finally {
      await context.close();
      await cleanLookups(db, person);
    }
  });

  test(`the phone's fold keeps today on the card's colour (${scheme}, 360px)`, async ({ browser, baseURL, db, person }) => {
    await seed(db, person);
    const { context, page } = await open(browser, baseURL, person, 360, scheme);
    try {
      await page.goto("/semana");
      const mark = page
        .getByRole("img", { name: new RegExp(`^${PENDING}, ${longName(today)}: `) })
        .and(page.locator(":visible"));
      await expect(mark).toHaveAttribute("data-state", "empty");
      const token = await tokens(page);
      const cell = await mark.evaluate((el) => {
        let node: Element | null = el;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
          node = node.parentElement;
        }
        return "none";
      });
      expect(cell).toBe(token.raised);
    } finally {
      await context.close();
      await cleanLookups(db, person);
    }
  });

  test(`a week with no goals draws no table (${where})`, async ({ browser, baseURL, person }) => {
    const { context, page } = await open(browser, baseURL, person, 1440, scheme);
    try {
      await page.goto("/semana");
      await settled(page);
      await expect(page.locator("table")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
