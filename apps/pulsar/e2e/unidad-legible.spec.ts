import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, settled, type Person } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// Module 857 (docs/pulsar/DESIGN.md "Tokens", taken 2026-10-11): the unit beside a figure, in a `Figure`, a table cell
// and a table header, is `--pulsar-muted` on both faces; `--pulsar-quiet` keeps its value and draws strokes. Colours are
// read off the page's own tokens, never typed here.

const today = todayInZone();
const monthStart = `${today.slice(0, 7)}-01`;
const stamp = Date.now();

type Face = "light" | "dark";
const FACES: Face[] = ["light", "dark"];

async function seedGoal(db: postgres.Sql, person: Person, unit: string, budget: number, done: number): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Unidad ${unit} ${stamp}`}, ${`${today.slice(0, 4)}-12-31`}, ${unit}, ${unit}, now() - interval '40 days')
    returning id`;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${monthStart}::date, ${budget})`;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Ronda ${unit}`}, 'daily', 'quantity', 5, ${unit}, now() - interval '40 days')
    returning id`;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${commitment.id}, ${today}::date, ${done})`;
  return goal.id;
}

async function open(browser: Browser, baseURL: string | undefined, person: Person, path: string, width: number, face: Face) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width, height: 900 },
    colorScheme: face,
  });
  const page = await context.newPage();
  await page.goto(path);
  await settled(page);
  return { page, close: () => context.close() };
}

// A token as the browser paints it: a probe given `color: var(--name)`.
function token(page: Page, name: "--pulsar-muted" | "--pulsar-quiet"): Promise<string> {
  return page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

type Seen = { text: string; color: string; ratio: number };

// Every visible element of one primitive's unit class, its colour and its contrast against the first painted ground.
function seen(page: Page, module: "figure" | "table", cls: "unit" | "headerUnit" | "chevron"): Promise<Seen[]> {
  return page.evaluate(
    ([moduleName, className]) => {
      const channels = (css: string) => css.match(/[\d.]+/g)!.map(Number);
      const luminance = ([r, g, b]: number[]) => {
        const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ground = (el: Element): number[] => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const bg = getComputedStyle(node).backgroundColor;
          const parts = channels(bg);
          if (parts.length === 3 || parts[3] > 0.99) return parts;
        }
        return [255, 255, 255];
      };
      const nodes = document.querySelectorAll<HTMLElement>(`[class*='${moduleName}-module'][class*='__${className}']`);
      return [...nodes]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const color = getComputedStyle(el).color;
          const a = luminance(channels(color));
          const b = luminance(ground(el));
          return {
            text: (el.textContent ?? "").trim(),
            color,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
    },
    [module, cls] as const,
  );
}

function allPaint(units: Seen[], color: string, what: string) {
  expect(units.length, `${what}: at least one is on screen`).toBeGreaterThan(0);
  for (const unit of units) expect(unit.color, `${what} «${unit.text}»`).toBe(color);
}

for (const face of FACES) {
  test(`/metas/<id> at 360, ${face}: the unit of a Figure is --pulsar-muted`, async ({ person, browser, baseURL, db }) => {
    const goalId = await seedGoal(db, person, "búsquedas", 60, 30);
    const { page, close } = await open(browser, baseURL, person, `/metas/${goalId}`, 360, face);
    try {
      const muted = await token(page, "--pulsar-muted");
      const quiet = await token(page, "--pulsar-quiet");
      expect(muted, "the face has two different tokens").not.toBe(quiet);
      const units = await seen(page, "figure", "unit");
      expect(units.map((u) => u.text)).toContain("búsquedas");
      allPaint(units, muted, "Figure unit");
    } finally {
      await close();
    }
  });
}

// The phone's list on /exportar draws the cell's unit in `Table`; the wide face draws a Figure there, so at 1280 the
// cell's own unit is the weekly review's lead cell.
for (const [width, where] of [[360, "/exportar"], [1280, "/metas/<id>/revision"]] as const) {
  test(`${where} at ${width}: the unit inside a table cell is --pulsar-muted`, async ({ person, browser, baseURL, db }) => {
    const goalId = await seedGoal(db, person, "minutos", 480, 90);
    await seedGoal(db, person, "km", 40, 20);
    const path = where === "/exportar" ? where : `/metas/${goalId}/revision`;
    const { page, close } = await open(browser, baseURL, person, path, width, "light");
    try {
      const muted = await token(page, "--pulsar-muted");
      const units = await seen(page, "table", "unit");
      allPaint(units, muted, "table cell unit");
    } finally {
      await close();
    }
  });
}

test("/exportar at 1280: the «km» in the header of a measured column is --pulsar-muted", async ({ person, browser, baseURL, db }) => {
  await seedGoal(db, person, "km", 40, 20);
  const { page, close } = await open(browser, baseURL, person, "/exportar", 1280, "light");
  try {
    const muted = await token(page, "--pulsar-muted");
    const units = await seen(page, "table", "headerUnit");
    expect(units.map((u) => u.text)).toContain("km");
    allPaint(units, muted, "header unit");
  } finally {
    await close();
  }
});

test("/metas/<id>/meses at 360: the row chevron stays --pulsar-quiet, a stroke and not a word", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, "km", 40, 20);
  const { page, close } = await open(browser, baseURL, person, `/metas/${goalId}/meses`, 360, "light");
  try {
    const quiet = await token(page, "--pulsar-quiet");
    const muted = await token(page, "--pulsar-muted");
    expect(quiet).not.toBe(muted);
    allPaint(await seen(page, "table", "chevron"), quiet, "chevron");
  } finally {
    await close();
  }
});

test("dark at 360: every unit beside a figure reads at 4.5:1 or more against its ground", async ({ person, browser, baseURL, db }) => {
  const goalId = await seedGoal(db, person, "búsquedas", 60, 30);
  await seedGoal(db, person, "km", 40, 20);
  for (const path of [`/metas/${goalId}`, "/exportar"]) {
    const { page, close } = await open(browser, baseURL, person, path, 360, "dark");
    try {
      const units = [
        ...(await seen(page, "figure", "unit")),
        ...(await seen(page, "table", "unit")),
        ...(await seen(page, "table", "headerUnit")),
      ];
      expect(units.length, `${path}: units on screen`).toBeGreaterThan(0);
      for (const unit of units) expect(unit.ratio, `${path} «${unit.text}»`).toBeGreaterThanOrEqual(4.5);
    } finally {
      await close();
    }
  }
});

for (const face of FACES) {
  test(`/exportar in print, from the ${face} face: the unit is black`, async ({ person, browser, baseURL, db }) => {
    await seedGoal(db, person, "km", 40, 20);
    await seedGoal(db, person, "minutos", 480, 90);
    const { page, close } = await open(browser, baseURL, person, "/exportar", 1280, face);
    try {
      await page.emulateMedia({ media: "print" });
      const units = [...(await seen(page, "figure", "unit")), ...(await seen(page, "table", "unit")), ...(await seen(page, "table", "headerUnit"))];
      allPaint(units, "rgb(0, 0, 0)", "printed unit");
    } finally {
      await close();
    }
  });
}
