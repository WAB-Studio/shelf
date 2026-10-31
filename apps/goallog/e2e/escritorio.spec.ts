
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import postgres from "postgres";

import { test, expect, mintDisposablePerson } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";
import plan from "../messages/es/plan.json";
import { boxOf } from "./box";

// RNP-17 across the app (`HoyEscritorio`, `SemanaEscritorio`, `MetaEscritorio`,
// `RevisionEscritorio`, `HojaEscritorio`): at 1280 × 800 every route is the
// desktop face, at 767 the phone face. Nothing scrolls sideways, the rail is
// there and no bottom nav, no two visible controls overlap and each one's
// shorter side reaches 32 px. «Visible control» is what the query below
// selects: a link, button, field, select, role=button or role=tab with a box
// and `visibility` not hidden — the face that is not drawn is `display: none`
// and has no box, so it is not measured.
const MIN_SIDE = 32;
const RAIL = 232;

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const yesterday = shift(today, -1);
// Days of the Monday-to-Sunday week already behind today: 0 on a Monday, 6 on a Sunday.
const daysBehind = weekOf(today).indexOf(today);
const stamp = Date.now();
const LONG_GOAL = `Meta de medición a 1280 con un nombre bastante largo para forzar el ajuste ${stamp}`;
const QUANTITY = `Leer páginas del libro con un nombre largo ${stamp}`;
const TAP = `Repasar tarjetas ${stamp}`;
const ONE_OFF = `Suelta de medición ${stamp}`;
const SCHEDULED = `Programada de medición ${stamp}`;
const ENDED = `Meta terminada de medición ${stamp}`;

// A person of this spec's own, registered under the suite's run whose teardown
// drops it: the ended goal and the scheduled one-off are states the shared
// identity cannot promise while its siblings count its goals and one-offs.
type Measured = { count: number; violations: string[] };

async function measure(page: Page, rootSelector: string | null, width: number): Promise<Measured> {
  return page.evaluate(
    ({ rootSelector, width, minSide }) => {
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      const violations: string[] = [];
      const scrollWidth = document.documentElement.scrollWidth;
      if (scrollWidth > width) violations.push(`scrollWidth ${scrollWidth} > ${width}`);
      if (!root) return { count: 0, violations: [`no root ${rootSelector}`] };

      const describe = (el: Element) => {
        const label = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}[${label}]`;
      };
      const isFixed = (el: Element) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (getComputedStyle(node).position === "fixed") return true;
        }
        return false;
      };

      const controls = Array.from(
        root.querySelectorAll(
          'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]',
        ),
      )
        .map((el) => ({ el, rect: el.getBoundingClientRect(), style: getComputedStyle(el) }))
        .filter(({ rect, style }) => rect.width > 0 && rect.height > 0 && style.visibility !== "hidden");

      for (const { el, rect } of controls) {
        const side = Math.min(rect.width, rect.height);
        if (side < minSide) {
          violations.push(`${describe(el)} shorter side ${side.toFixed(1)} < ${minSide} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`);
        }
        if (rect.right > width + 0.5 || rect.left < -0.5) {
          violations.push(`${describe(el)} leaves the viewport: left ${rect.left.toFixed(1)} right ${rect.right.toFixed(1)}`);
        }
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i];
          const b = controls[j];
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          if (isFixed(a.el) !== isFixed(b.el)) continue;
          const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
          const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
          if (x > 0.5 && y > 0.5) {
            violations.push(`${describe(a.el)} overlaps ${describe(b.el)} by ${x.toFixed(1)}x${y.toFixed(1)}`);
          }
        }
      }
      return { count: controls.length, violations };
    },
    { rootSelector, width, minSide: MIN_SIDE },
  );
}

// A screen with nothing to measure would pass by proving nothing.
async function expectHolds(page: Page, width: number, minControls: number, rootSelector: string | null = null) {
  const { count, violations } = await measure(page, rootSelector, width);
  expect(count).toBeGreaterThanOrEqual(minControls);
  if (violations.length > 0) {
    await page.screenshot({ path: test.info().outputPath("violations.png"), fullPage: true });
  }
  expect(violations).toEqual([]);
}

// The open animation ends by itself: waits on it, never on the clock.
async function settled(dialog: Locator) {
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
}

async function railBox(page: Page) {
  return page.getByRole("navigation").evaluate((el) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  });
}

type World = { personId: string; sessionFile: string; goalId: string };

// One person per worker for every case here: seeded once, gone when the worker
// ends. A failed case never skips the ones after it.
const worldTest = test.extend<object, { world: World }>({
  world: [
    async ({}, provide, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      const person = mintDisposablePerson(baseURL ?? "http://localhost:3200");
      const admin = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
      const personId = person.id;
      try {
        const created = new Date(Date.now() - 20 * 86_400_000);
        const [goal] = await admin<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon, created_at)
          values (${personId}, ${LONG_GOAL}, ${shift(today, 90)}, ${created}) returning id
        `;
        await admin`
          insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
          values (${personId}, ${goal.id}, 'Sostener el ritmo diario sin saltarse ninguno', ${shift(today, -7)}, ${shift(today, 30)})
        `;
        await admin`
          insert into goals.commitments
            (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
          values (${personId}, ${goal.id}, ${QUANTITY}, 'daily', 'quantity', 20, 'páginas', ${created})
        `;
        const [tap] = await admin<{ id: string }[]>`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
          values (${personId}, ${goal.id}, ${TAP}, 'daily', 'tap', ${created}) returning id
        `;
        await admin`insert into goals.facts (user_id, commitment_id, day) values (${personId}, ${tap.id}, ${yesterday})`;
        await admin`insert into goals.one_offs (user_id, name, day) values (${personId}, ${ONE_OFF}, ${today})`;
        await admin`insert into goals.one_offs (user_id, name, day) values (${personId}, ${SCHEDULED}, ${shift(today, 2)})`;
        const [ended] = await admin<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon, created_at)
          values (${personId}, ${ENDED}, ${today}, ${created}) returning id
        `;
        await admin`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
          values (${personId}, ${ended.id}, 'Compromiso terminado', 'daily', 'tap', ${created})
        `;
        await provide({ personId, sessionFile: person.sessionFile, goalId: goal.id });
      } finally {
        await admin`delete from goals.facts where user_id = ${personId}`;
        await admin`delete from goals.one_offs where user_id = ${personId}`;
        await admin`delete from goals.goals where user_id = ${personId}`;
        await admin.end();
      }
    },
    { scope: "worker" },
  ],
});

async function signedIn(browser: Browser, baseURL: string | undefined, world: World, width: number, height: number) {
  const context: BrowserContext = await browser.newContext({
    baseURL,
    storageState: world.sessionFile,
    viewport: { width, height },
  });
  return { context, page: await context.newPage() };
}

type Route = { name: string; path: (world: World) => string; ready: (page: Page) => Promise<void>; min: number };

const ROUTES: Route[] = [
  { name: "/", path: () => "/", ready: (p) => expect(p.getByText(QUANTITY).first()).toBeVisible(), min: 5 },
  {
    name: "/dia/<yesterday>",
    path: () => `/dia/${yesterday}`,
    ready: (p) => expect(p.getByText(TAP).first()).toBeVisible(),
    min: 4,
  },
  // Four fixed controls plus one link per past day of the week (RP-06):
  // a Monday draws none, today is never a link.
  { name: "/semana", path: () => "/semana", ready: (p) => expect(p.getByRole("table")).toBeVisible(), min: 4 + daysBehind },
  { name: "/sueltas", path: () => "/sueltas", ready: (p) => expect(p.getByText(SCHEDULED).first()).toBeVisible(), min: 5 },
  { name: "/metas", path: () => "/metas", ready: (p) => expect(p.getByText(ENDED).first()).toBeVisible(), min: 5 },
  { name: "/metas/nueva", path: () => "/metas/nueva", ready: (p) => expect(p.getByLabel("nombre")).toBeVisible(), min: 5 },
  {
    name: "/metas/<id>",
    path: (world) => `/metas/${world.goalId}`,
    ready: (p) => expect(p.getByRole("button", { name: "Renombrar" })).toBeVisible(),
    min: 8,
  },
  {
    name: "/metas/<id>/compromisos/nuevo",
    path: (world) => `/metas/${world.goalId}/compromisos/nuevo`,
    ready: (p) => expect(p.getByText("Compromiso nuevo")).toBeVisible(),
    min: 6,
  },
  {
    name: "/metas/<id>/fases/nueva",
    path: (world) => `/metas/${world.goalId}/fases/nueva`,
    ready: (p) => expect(p.getByText(plan.phaseForm.title)).toBeVisible(),
    min: 5,
  },
  {
    name: "/metas/<id>/revision",
    path: (world) => `/metas/${world.goalId}/revision`,
    ready: (p) => expect(p.locator("main")).toHaveCount(1),
    min: 4,
  },
  {
    name: "/no-existe",
    path: () => "/no-existe",
    ready: (p) => expect(p.getByRole("heading", { name: "Esta página no existe" })).toBeVisible(),
    min: 4,
  },
];

for (const route of ROUTES) {
  worldTest(`${route.name} holds at 1280 × 800: rail, no bottom nav, one toggle, nothing over anything (RNP-17)`, async ({
    browser,
    baseURL,
    world,
  }) => {
    const { context, page } = await signedIn(browser, baseURL, world, 1280, 800);
    try {
      await page.goto(route.path(world));
      await route.ready(page);

      // The nav is the rail: down the left edge, from the top, 232 wide —
      // never a bar at the foot.
      const rail = await railBox(page);
      expect(rail).toMatchObject({ x: 0, y: 0, width: RAIL });
      expect(rail.height).toBeGreaterThan(400);
      await expect(
        page.getByRole("navigation").getByRole("link").filter({ hasText: /^(Hoy|Semana|Mes|Metas)$/ }),
      ).toHaveCount(4);
      await expect(page.getByRole("navigation").getByText("GoalLog")).toBeVisible();

      // Two toggles would be the phone face drawn beside the rail's own.
      await expect(page.getByRole("button", { name: /^Cambiar a modo/ })).toHaveCount(1);

      await expectHolds(page, 1280, route.min);
    } finally {
      await context.close();
    }
  });
}

worldTest("the quantity sheet on Hoy opens centred at 480 px at 1280 (RNP-17)", async ({ browser, baseURL, world }) => {
  const { context, page } = await signedIn(browser, baseURL, world, 1280, 800);
  try {
    await page.goto("/");
    await page.locator("button", { hasText: QUANTITY }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("width", "480px");
    await settled(dialog);
    const box = (await boxOf(dialog));
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThanOrEqual(1);
    await expectHolds(page, 1280, 3, '[role="dialog"]');
  } finally {
    await context.close();
  }
});

worldTest("the rename sheet on the goal opens centred at 480 px at 1280 (RNP-17)", async ({ browser, baseURL, world }) => {
  const { context, page } = await signedIn(browser, baseURL, world, 1280, 800);
  try {
    await page.goto(`/metas/${world.goalId}`);
    await page.getByRole("button", { name: "Renombrar" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("width", "480px");
    await settled(dialog);
    const box = (await boxOf(dialog));
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThanOrEqual(1);
    await expectHolds(page, 1280, 3, '[role="dialog"]');
  } finally {
    await context.close();
  }
});

worldTest("the move sheet on /sueltas opens centred at 480 px at 1280 (RNP-17)", async ({ browser, baseURL, world }) => {
  const { context, page } = await signedIn(browser, baseURL, world, 1280, 800);
  try {
    await page.goto("/sueltas");
    await page.getByRole("button", { name: new RegExp(`^${SCHEDULED}`) }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("width", "480px");
    await settled(dialog);
    const box = (await boxOf(dialog));
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThanOrEqual(1);
    await expectHolds(page, 1280, 3, '[role="dialog"]');
  } finally {
    await context.close();
  }
});

// The phone face runs to 767: the nav four tabs fixed at the foot, no table, one toggle.
for (const path of ["/", "/semana", "/sueltas", "/metas"]) {
  worldTest(`${path} is still the phone face at 767 (RNP-17)`, async ({ browser, baseURL, world }) => {
    const { context, page } = await signedIn(browser, baseURL, world, 767, 740);
    try {
      await page.goto(path);
      await expect(page.locator("main")).toHaveCount(1);

      const nav = await railBox(page);
      expect(nav).toMatchObject({ x: 0, width: 767 });
      // The bar is fixed to the viewport's foot, under the screen, never beside it.
      expect(nav.y + nav.height).toBe(740);
      expect(nav.height).toBeLessThan(100);
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(page.getByRole("navigation").getByText("GoalLog")).toBeHidden();
      await expect(page.getByRole("button", { name: /^Cambiar a modo/ })).toHaveCount(path === "/" ? 1 : 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(767);
    } finally {
      await context.close();
    }
  });
}

// At 1024 and 1280, a person of the
// spec's own for each: `layout` is a wide open plan, `closed` holds no open
// goal at all, so neither depends on a sibling's rows.
const LAYOUT_GOAL = `Meta de medición amplia con un nombre largo ${stamp}`;
const LONG_COMMITMENT = "Dormir ocho horas antes de un día de entrenamiento fuerte";
const CLOSED_ENDED = `Meta terminada cerrada ${stamp}`;
const CLOSED_ARCHIVED = `Meta archivada cerrada ${stamp}`;
const BANK = `Llamar al banco ${stamp}`;

type Desk = { layoutSession: string; layoutGoalId: string; closedSession: string; endedId: string; archivedId: string; closedId: string };

const deskTest = test.extend<object, { desk: Desk }>({
  desk: [
    async ({}, provide, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL ?? "http://localhost:3200";
      const layout = mintDisposablePerson(baseURL);
      const closed = mintDisposablePerson(baseURL);
      const admin = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
      try {
        const created = new Date(Date.now() - 20 * 86_400_000);
        const [goal] = await admin<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon, created_at, measure_name, measure_unit)
          values (${layout.id}, ${LAYOUT_GOAL}, ${shift(today, 90)}, ${created}, 'Sueño', 'horas') returning id
        `;
        await admin`
          insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
          values (${layout.id}, ${goal.id}, 'Sostener el ritmo diario', ${shift(today, -7)}, ${shift(today, 30)})
        `;
        for (let index = 0; index < 16; index++) {
          const name = index === 0 ? LONG_COMMITMENT : `Compromiso de la tabla ${index}`;
          const [row] = await admin<{ id: string }[]>`
            insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
            values (${layout.id}, ${goal.id}, ${name}, 'daily', 'tap', ${created}) returning id
          `;
          if (index < 3) await admin`insert into goals.facts (user_id, commitment_id, day) values (${layout.id}, ${row.id}, ${today})`;
        }

        const [ended] = await admin<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon, created_at)
          values (${closed.id}, ${CLOSED_ENDED}, ${today}, ${created}) returning id
        `;
        const [archived] = await admin<{ id: string }[]>`
          insert into goals.goals (user_id, name, horizon, created_at, archived_at)
          values (${closed.id}, ${CLOSED_ARCHIVED}, ${shift(today, 60)}, ${created}, now()) returning id
        `;
        await admin`insert into goals.one_offs (user_id, name, day) values (${closed.id}, ${BANK}, ${today})`;

        await provide({
          layoutSession: layout.sessionFile,
          layoutGoalId: goal.id,
          closedSession: closed.sessionFile,
          endedId: ended.id,
          archivedId: archived.id,
          closedId: closed.id,
        });
      } finally {
        for (const id of [layout.id, closed.id]) {
          await admin`delete from goals.facts where user_id = ${id}`;
          await admin`delete from goals.one_offs where user_id = ${id}`;
          await admin`delete from goals.goals where user_id = ${id}`;
        }
        await admin.end();
      }
    },
    { scope: "worker" },
  ],
});

// The width of the card a piece of text stands in.
function cardWidth(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    let node: Element | null = el;
    while (node && getComputedStyle(node).borderTopLeftRadius !== "14px") node = node.parentElement;
    return node ? node.getBoundingClientRect().width : 0;
  });
}

deskTest("at 1024 the main column is the wider one on Hoy and on the goal, and the side cards stack with no hole", async ({ browser, baseURL, desk }) => {
  const { context, page } = await signedIn(browser, baseURL, { sessionFile: desk.layoutSession } as World, 1024, 800);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    const goalCard = await cardWidth(page.getByText(LAYOUT_GOAL, { exact: true }).first());
    const oneOffs = await cardWidth(page.getByText("Sueltas", { exact: true }).first());
    expect(goalCard).toBeGreaterThan(oneOffs);

    await page.goto(`/metas/${desk.layoutGoalId}`);
    await expect(page.locator("main")).toHaveCount(1);
    const commitments = await cardWidth(page.getByText(LONG_COMMITMENT, { exact: true }));
    const end = page.getByText("El final", { exact: true });
    const side = await cardWidth(end);
    expect(commitments).toBeGreaterThan(side);
    // «Dormir ocho horas antes de un día de entrenamiento fuerte» took five lines in the narrow column.
    // The row's 30-day strip (DESIGN «Constancy is a 30-day strip») takes 120 px of the trailing block, so three is the most.
    const lines = await page.getByText(LONG_COMMITMENT, { exact: true }).evaluate(
      (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    );
    expect(lines).toBeLessThanOrEqual(3);

    // The phases card stands under both columns (DESIGN «The goal at 1024 draws
    // its phases on a full-width row»): it follows the lower of the commitments
    // card and the measure card by the row gap alone.
    const gap = await page.evaluate((longCommitment) => {
      const card = (text: string) => {
        const label = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim().toLowerCase() === text.toLowerCase())!;
        let node: Element | null = label;
        while (node && getComputedStyle(node).borderTopLeftRadius !== "14px") node = node.parentElement;
        return node!.getBoundingClientRect();
      };
      return card("una fase").top - Math.max(card(longCommitment).bottom, card("el final").bottom);
    }, LONG_COMMITMENT);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(60);
  } finally {
    await context.close();
  }
});

deskTest("at 1280 the side column keeps its drawn widths, 360 on Hoy and 380 on the goal", async ({ browser, baseURL, desk }) => {
  const { context, page } = await signedIn(browser, baseURL, { sessionFile: desk.layoutSession } as World, 1280, 800);
  try {
    await page.goto("/");
    await expect(page.locator("main")).toHaveCount(1);
    expect(await cardWidth(page.getByText("Sueltas", { exact: true }).first())).toBe(360);
    await page.goto(`/metas/${desk.layoutGoalId}`);
    await expect(page.locator("main")).toHaveCount(1);
    expect(await cardWidth(page.getByText("El final", { exact: true }))).toBe(380);
  } finally {
    await context.close();
  }
});

deskTest("Semana's day header stays in view and opaque once the rows scroll, at 1280", async ({ browser, baseURL, desk }) => {
  const { context, page } = await signedIn(browser, baseURL, { sessionFile: desk.layoutSession } as World, 1280, 800);
  try {
    await page.goto("/semana");
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(scrollable).toBeGreaterThan(400);
    await page.evaluate(() => window.scrollTo(0, 500));

    const head = await table.getByRole("columnheader").first().evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        top: rect.top,
        covered: !el.contains(hit),
        fill: getComputedStyle(el).backgroundColor,
        card: getComputedStyle(el.closest("table")!.parentElement!).backgroundColor,
      };
    });
    expect(Math.abs(head.top)).toBeLessThanOrEqual(1);
    expect(head.covered).toBe(false);
    expect(head.fill).toBe(head.card);

    // Dark: the same fill as the card, never transparent.
    await page.evaluate(() => {
      document.documentElement.classList.remove("light");
      document.documentElement.classList.add("dark");
    });
    const dark = await table.getByRole("columnheader").first().evaluate((el) => ({
      fill: getComputedStyle(el).backgroundColor,
      card: getComputedStyle(el.closest("table")!.parentElement!).backgroundColor,
    }));
    expect(dark.fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(dark.fill).toBe(dark.card);
  } finally {
    await context.close();
  }
});

deskTest("at 1024 no day header and no tally on Semana wraps", async ({ browser, baseURL, desk }) => {
  const { context, page } = await signedIn(browser, baseURL, { sessionFile: desk.layoutSession } as World, 1024, 800);
  try {
    await page.goto("/semana");
    await expect(page.getByRole("table")).toBeVisible();
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll("thead th, tfoot td")]
        .filter((el) => (el.textContent ?? "").trim() !== "")
        .map((el) => {
          // Drawn text only: the clipped mark holds a text node of its own.
          const tops = new Set<number>();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!(node.textContent ?? "").trim()) continue;
            if (getComputedStyle(node.parentElement!).clipPath !== "none") continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
          }
          return { text: (el.textContent ?? "").trim(), lines: tops.size };
        }),
    );
    // Seven day headers and the tallies of the days up to and including today.
    expect(lines.length).toBeGreaterThanOrEqual(7 + daysBehind + 1);
    // The grid draws a header over two lines (the day's name over its number) and a tally as a
    // figure over its bar (DESIGN «Semana is a grid»); a third line is a wrap.
    expect(lines.filter((entry) => entry.lines > 2)).toEqual([]);
  } finally {
    await context.close();
  }
});

deskTest("Hoy with every goal ended drops «Hoy no pide nada.» while a one-off waits, and says it as body text at 1280", async ({ browser, baseURL, desk }) => {
  const admin = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
  const sentence = "Hoy no pide nada.";
  const wide = await signedIn(browser, baseURL, { sessionFile: desk.closedSession } as World, 1280, 800);
  const phone = await signedIn(browser, baseURL, { sessionFile: desk.closedSession } as World, 360, 740);
  try {
    // A one-off waits: the ended-goal line and its two ways stay, the sentence goes.
    await wide.page.goto("/");
    await expect(wide.page.getByText(BANK, { exact: true })).toBeVisible();
    await expect(wide.page.getByText(`${CLOSED_ENDED} terminó el`)).toBeVisible();
    await expect(wide.page.getByRole("link", { name: "Ver las metas" })).toBeVisible();
    await expect(wide.page.getByRole("link", { name: "Abrir otra meta" })).toBeVisible();
    await expect(wide.page.getByText(sentence)).toHaveCount(0);

    // Nothing waits: the sentence is body text beside the rail and the phone's title on the phone.
    await admin`delete from goals.one_offs where user_id = ${desk.closedId}`;
    await wide.page.reload();
    await phone.page.goto("/");
    await expect(wide.page.getByText(sentence)).toBeVisible();
    await expect(wide.page.getByText(sentence)).toHaveCSS("font-size", "15px");
    await expect(phone.page.getByText(sentence)).toBeVisible();
    await expect(phone.page.getByText(sentence)).toHaveCSS("font-size", "30px");
  } finally {
    await wide.context.close();
    await phone.context.close();
    await admin`insert into goals.one_offs (user_id, name, day) values (${desk.closedId}, ${BANK}, ${today})`;
    await admin.end();
  }
});

deskTest("an ended or archived goal is «no existe» on «fases/nueva» and on «compromisos/nuevo»", async ({ browser, baseURL, desk }) => {
  const { context, page } = await signedIn(browser, baseURL, { sessionFile: desk.closedSession } as World, 1280, 800);
  try {
    for (const id of [desk.endedId, desk.archivedId]) {
      for (const path of ["fases/nueva", "compromisos/nuevo"]) {
        // The stream has begun by the time `notFound` throws, so the answer is the page's own.
        await page.goto(`/metas/${id}/${path}`);
        await expect(page.getByRole("heading", { name: "Esta página no existe" }), `${id}/${path}`).toBeVisible();
      }
    }
  } finally {
    await context.close();
  }
});

deskTest("an archived goal's overline says it is archived, and an open one still says it was opened", async ({ browser, baseURL, desk }) => {
  const { context, page } = await signedIn(browser, baseURL, { sessionFile: desk.closedSession } as World, 1280, 800);
  const on = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Bogota" }).format(new Date());
  try {
    await page.goto(`/metas/${desk.archivedId}`);
    await expect(page.getByText(`meta · archivada el ${on}`, { exact: true })).toBeVisible();
    await expect(page.getByText(/abierta el/)).toHaveCount(0);
    await page.goto(`/metas/${desk.endedId}`);
    await expect(page.getByText(/^meta · abierta el /)).toBeVisible();
  } finally {
    await context.close();
  }
});
