import type { Browser, Locator, Page } from "@playwright/test";

import { test, expect, settled, type Person } from "./fixtures";
import chat from "../messages/es/chat.json";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-91, P1 = B (`ChatEntrada`, 2026-10-13): every screen of `app/(app)` draws one link to /chat at the
// end of its header, and /chat itself draws none. RNP-16 and RNP-17 stay: the tab bar keeps four links and
// the rail keeps the places it listed. The header is a `<header>` inside `<main>`, which has no banner role.

const stamp = Date.now();
const GOAL = `Entrada ${stamp}`;
const today = todayInZone();
const month = today.slice(0, 7);

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

async function seedGoal(db: import("postgres").Sql, personId: string): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${GOAL}, ${shift(today, 90)}, ${new Date(Date.now() - 20 * 86_400_000)}) returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${`Tarea ${stamp}`}, 'daily', 'tap', ${new Date(Date.now() - 20 * 86_400_000)})
  `;
  return goal.id;
}

async function drop(db: import("postgres").Sql, id: string): Promise<void> {
  await db`delete from goals.goals where id = ${id}`;
}

async function open(browser: Browser, baseURL: string | undefined, person: Person, width: number) {
  const context = await browser.newContext({
    baseURL,
    storageState: person.sessionFile,
    viewport: { width, height: width < 1024 ? 740 : 800 },
    hasTouch: width < 1024,
  });
  return { context, page: await context.newPage() };
}

const entry = (page: Page): Locator =>
  page.locator("main > header").getByRole("link", { name: chat.open, exact: true });

type Box = { x: number; y: number; width: number; height: number };
const box = async (locator: Locator): Promise<Box> => (await locator.boundingBox())!;
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function screens(goal: string): { name: string; path: string }[] {
  return [
    { name: "Hoy", path: "/" },
    { name: "Semana", path: "/semana" },
    { name: "Mes", path: "/mes" },
    { name: "Metas", path: "/metas" },
    { name: "a goal", path: `/metas/${goal}` },
    { name: "a month", path: `/metas/${goal}/meses/${month}` },
    { name: "/sueltas", path: "/sueltas" },
    { name: "/conexiones", path: "/conexiones" },
    { name: "/exportar", path: "/exportar" },
  ];
}

test.describe("the way into the chat (RP-91, P1 = B)", () => {
  let goal: string;

  test.beforeEach(async ({ db, person }) => {
    goal = await seedGoal(db, person.id);
  });
  test.afterEach(async ({ db }) => {
    await drop(db, goal);
  });

  for (const width of [360, 1280]) {
    test(`at ${width} every screen's header draws one link to /chat, named from chat.json`, async ({
      browser,
      baseURL,
      person,
    }) => {
      const { context, page } = await open(browser, baseURL, person, width);
      try {
        for (const screen of screens(goal)) {
          await page.goto(screen.path);
          await settled(page);
          const link = entry(page);
          await expect(link, `${screen.name} at ${width}`).toHaveCount(1);
          await expect(link, `${screen.name} at ${width}`).toBeVisible();
          await expect(link, `${screen.name} at ${width}`).toHaveAttribute("href", "/chat");
          // Never a second one beside the header's: one entry per screen.
          await expect(page.getByRole("link", { name: chat.open, exact: true })).toHaveCount(1);
        }
      } finally {
        await context.close();
      }
    });
  }

  test("one tap from Hoy lands on /chat with the empty chat's heading", async ({ browser, baseURL, person }) => {
    const { context, page } = await open(browser, baseURL, person, 360);
    try {
      await page.goto("/");
      await settled(page);
      await entry(page).tap();
      await page.waitForURL(/\/chat$/);
      await expect(page.getByRole("heading", { name: chat.title, exact: true })).toBeVisible();
      await expect(page.getByText(chat.tryWith, { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 1280]) {
    test(`at ${width} /chat draws no link to itself`, async ({ browser, baseURL, person }) => {
      const { context, page } = await open(browser, baseURL, person, width);
      try {
        await page.goto("/chat");
        await settled(page);
        await expect(page.getByRole("heading", { name: chat.title, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: chat.open, exact: true })).toHaveCount(0);
        await expect(page.locator('main a[href="/chat"]')).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  }

  test("at 360 the entry is a 32 px target at the header's end, clear of the title, the controls and the edge", async ({
    browser,
    baseURL,
    person,
  }) => {
    const { context, page } = await open(browser, baseURL, person, 360);
    try {
      for (const screen of screens(goal)) {
        await page.goto(screen.path);
        await settled(page);
        const at = `${screen.name} at 360`;
        const link = entry(page);
        await expect(link, at).toBeVisible();
        const mine = await box(link);
        expect(mine.width, `${at}: width`).toBeGreaterThanOrEqual(32);
        expect(mine.height, `${at}: height`).toBeGreaterThanOrEqual(32);
        expect(mine.x, `${at}: inside the left edge`).toBeGreaterThanOrEqual(0);
        expect(mine.x + mine.width, `${at}: inside the right edge`).toBeLessThanOrEqual(360);
        expect(await page.evaluate(() => document.documentElement.scrollWidth), `${at}: no overflow`).toBeLessThanOrEqual(360);

        const title = page.locator("main > header").getByRole("heading", { level: 1 });
        const heading = await box(title);
        expect(overlap(mine, heading), `${at}: the title is not covered`).toBe(false);
        // The title's own centre still hits the title, and the entry's hits the entry.
        const hit = await page.evaluate(
          ([tx, ty, lx, ly]) => ({
            title: document.elementFromPoint(tx, ty)?.closest("h1") !== null,
            link: document.elementFromPoint(lx, ly)?.closest("a")?.getAttribute("href"),
          }),
          [heading.x + heading.width / 2, heading.y + heading.height / 2, mine.x + mine.width / 2, mine.y + mine.height / 2],
        );
        expect(hit.title, `${at}: the title is on top at its centre`).toBe(true);
        expect(hit.link, `${at}: the entry is on top at its centre`).toBe("/chat");

        // Every other control of the header keeps its own box.
        const others = page.locator("main > header").locator("a, button").filter({ hasNot: link });
        for (const other of await others.all()) {
          if (!(await other.isVisible())) continue;
          const name = (await other.getAttribute("aria-label")) ?? (await other.textContent());
          if (name === chat.open) continue;
          expect(overlap(mine, await box(other)), `${at}: no overlap with «${name}»`).toBe(false);
        }
      }
    } finally {
      await context.close();
    }
  });

  for (const width of [360, 1280]) {
    test(`at ${width} on Hoy and Metas the entry sits at the right end, over the title's line`, async ({
      browser,
      baseURL,
      person,
    }) => {
      const { context, page } = await open(browser, baseURL, person, width);
      try {
        for (const path of ["/", "/metas"]) {
          await page.goto(path);
          await settled(page);
          const at = `${path} at ${width}`;
          const header = await box(page.locator("main > header").first());
          const mine = await box(entry(page));
          const title = await box(page.locator("main > header").getByRole("heading", { level: 1 }));
          expect(mine.y + mine.height, `${at}: above the title`).toBeLessThanOrEqual(title.y + 2);
          expect(header.x + header.width - (mine.x + mine.width), `${at}: ends the header`).toBeLessThanOrEqual(24);
          expect(mine.x, `${at}: at the right half`).toBeGreaterThan(header.x + header.width / 2);
        }
        if (width === 360) {
          // Hoy: right of the theme control, on its line.
          await page.goto("/");
          await settled(page);
          const toggle = await box(page.locator("main > header").getByRole("button", { name: /modo (oscuro|claro)/ }));
          const mine = await box(entry(page));
          expect(mine.x, "Hoy: right of the theme control").toBeGreaterThanOrEqual(toggle.x + toggle.width - 1);
          expect(Math.abs(mine.y + mine.height / 2 - (toggle.y + toggle.height / 2)), "Hoy: on its line").toBeLessThanOrEqual(8);
        }
      } finally {
        await context.close();
      }
    });
  }

  test("at 1280 the rail lists the same places as before and never the chat", async ({ browser, baseURL, person }) => {
    const { context, page } = await open(browser, baseURL, person, 1280);
    try {
      for (const screen of screens(goal)) {
        await page.goto(screen.path);
        await settled(page);
        await expect(entry(page), screen.name).toBeVisible();
        const links = page.getByRole("navigation").getByRole("link");
        // Hoy, Semana, Mes, Metas and the one open goal.
        await expect(links, `${screen.name}: rail count`).toHaveCount(5);
        await expect(links.filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ }), screen.name).toHaveCount(4);
        await expect(links.filter({ hasText: GOAL }), screen.name).toHaveCount(1);
        await expect(page.getByRole("navigation").getByRole("link", { name: chat.open }), screen.name).toHaveCount(0);
        await expect(page.getByRole("navigation").locator('a[href="/chat"]'), screen.name).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });

  test("at 360 the tab bar keeps exactly four links, and none is the chat", async ({ browser, baseURL, person }) => {
    const { context, page } = await open(browser, baseURL, person, 360);
    try {
      for (const screen of [{ name: "Hoy", path: "/" }, ...screens(goal)]) {
        await page.goto(screen.path);
        await settled(page);
        await expect(entry(page), screen.name).toBeVisible();
        const links = page.getByRole("navigation").getByRole("link");
        await expect(links, screen.name).toHaveCount(4);
        await expect(links.filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ }), screen.name).toHaveCount(4);
        await expect(page.getByRole("navigation").locator('a[href="/chat"]'), screen.name).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });
});
