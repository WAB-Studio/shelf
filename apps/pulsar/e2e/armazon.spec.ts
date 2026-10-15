import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, settled, type Person } from "./fixtures";
import { planText, toReview } from "./importar-plan";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RNP-16, RNP-17, RNP-07: the shell's facts are true of every signed-in route
// or of none, so one spec walks them all at the four widths. A goal that
// measures and one that measures nothing stand under the same person.
const stamp = Date.now();
const MEASURED = `Barrido medida ${stamp}`;
const BARE = `Barrido sin medida ${stamp}`;
const WIDTHS = [360, 390, 1280, 1440];
const FORM_CAP = 560;
const TOLERANCE = 1;

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const yesterday = shift(today, -1);
const month = today.slice(0, 7);

function pastMonday(): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) - 14);
  return dateToCivilDate(date);
}

type Route = {
  name: string;
  path: string;
  // The accessible name the way back carries, or null when the route has none.
  back: RegExp | null;
  // A form keeps the board's cap on its fields.
  form?: boolean;
  // A screen that holds a cap of its own, named where it is not a form.
  cap?: number;
  // A route reached by a flow, not a URL: the review only draws with a draft in the tab.
  reach?: (page: Page) => Promise<void>;
};

type World = { measured: string; bare: string; habit: string };

async function seed(db: postgres.Sql, personId: string): Promise<World> {
  const created = new Date(Date.now() - 20 * 86_400_000);
  const horizon = shift(today, 90);
  const [measured] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${MEASURED}, ${horizon}, ${created}) returning id
  `;
  const [bare] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${BARE}, ${horizon}, ${new Date(created.getTime() + 1000)}) returning id
  `;
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${personId}, ${measured.id}, ${`Leer ${stamp}`}, 'daily', 'quantity', 20, 'páginas', ${created})
  `;
  for (let index = 0; index < 12; index++) {
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${personId}, ${measured.id}, ${`Compromiso ${index} ${stamp}`}, 'daily', 'tap', ${created})
    `;
  }
  await db`insert into goals.one_offs (user_id, name, day) values (${personId}, ${`Suelta ${stamp}`}, ${today})`;
  const [habit] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, null, ${`Hábito suelto ${stamp}`}, 'daily', 'tap', ${created}) returning id
  `;
  return { measured: measured.id, bare: bare.id, habit: habit.id };
}

function routes(world: World): Route[] {
  const goalRoutes = (id: string, label: string): Route[] => [
    { name: `${label} /metas/<id>`, path: `/metas/${id}`, back: /^Volver a / },
    { name: `${label} compromisos/nuevo`, path: `/metas/${id}/compromisos/nuevo`, back: /^Volver a /, form: true },
    { name: `${label} fases/nueva`, path: `/metas/${id}/fases/nueva`, back: /^Volver a /, form: true },
    { name: `${label} revision`, path: `/metas/${id}/revision`, back: /^Volver a / },
    { name: `${label} meses`, path: `/metas/${id}/meses`, back: /^Volver a / },
    { name: `${label} meses/<this month>`, path: `/metas/${id}/meses/${month}`, back: /^Volver a / },
    { name: `${label} tarea/nueva`, path: `/metas/${id}/meses/${month}/tarea/nueva`, back: /^Volver a /, form: true },
  ];
  return [
    { name: "/", path: "/", back: null },
    // The past day's way back is «volver a hoy», lowercase, not «Volver a …».
    { name: "/dia/<yesterday>", path: `/dia/${yesterday}`, back: /^volver a hoy$/ },
    { name: "/semana", path: "/semana", back: null },
    { name: "/semana?semana=<past>", path: `/semana?semana=${pastMonday()}`, back: null },
    { name: "/mes", path: "/mes", back: null },
    { name: "/sueltas", path: "/sueltas", back: /^Volver a /, cap: 640 },
    { name: "/metas", path: "/metas", back: null },
    { name: "/metas/nueva", path: "/metas/nueva", back: /^Volver a /, form: true },
    ...goalRoutes(world.measured, "measured"),
    ...goalRoutes(world.bare, "bare"),
    // `import-screen.tsx` draws its column in a 640px `Flex`.
    { name: "/metas/importar", path: "/metas/importar", back: /^Volver a /, cap: 640 },
    { name: "/exportar", path: "/exportar", back: /^Volver a / },
    // The 404 offers «Ir a hoy» and «Ver las metas», no way back.
    { name: "404", path: `/metas/00000000-0000-4000-8000-000000000000`, back: null, cap: FORM_CAP },
    // Still on `Page`'s default, so it draws the form cap.
    { name: "/conexiones", path: "/conexiones", back: /^Volver a /, cap: FORM_CAP },
    { name: "/metas/habitos/<id>", path: `/metas/habitos/${world.habit}`, back: /^Volver a /, cap: 640 },
    { name: "/metas/habitos/nuevo", path: "/metas/habitos/nuevo", back: /^Volver a /, form: true },
    { name: "/chat", path: "/chat", back: /^Volver a /, cap: 640 },
    { name: "bare plan", path: `/metas/${world.bare}/plan`, back: /^Volver a /, cap: 640 },
    {
      name: "/metas/importar/revisar",
      path: "/metas/importar/revisar",
      back: /^Volver a /,
      reach: (page) => toReview(page, planText()),
    },
  ];
}

async function open(browser: Browser, baseURL: string | undefined, person: Person, width: number, height: number) {
  const context = await browser.newContext({
    baseURL,
    storageState: person.sessionFile,
    viewport: { width, height },
    hasTouch: width < 1024,
  });
  return { context, page: await context.newPage() };
}

const loaded = (page: Page) => expect(page.getByRole("main")).toContainText(/\S/);

async function scrollToEnd(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

function navBox(page: Page) {
  return page.getByRole("navigation").evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom };
  });
}

function lastControlBottom(page: Page) {
  return page.getByRole("main").evaluate((main) => {
    const rects = Array.from(
      main.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea'),
    )
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    return { count: rects.length, bottom: Math.max(...rects.map((rect) => rect.bottom)) };
  });
}

// The widest block `main` holds under its header: the header spans the frame
// on every screen, so it says nothing of the content's span.
function contentWidth(page: Page) {
  return page.getByRole("main").evaluate((main) => {
    const widths = Array.from(main.children)
      .filter((el) => el.tagName !== "HEADER")
      .map((el) => el.getBoundingClientRect().width);
    return Math.max(0, ...widths);
  });
}

for (const width of WIDTHS) {
  test(`every route at ${width} holds the shell (RNP-16, RNP-17, RNP-07)`, async ({ browser, baseURL, person, db }) => {
    const world = await seed(db, person.id);
    const { context, page } = await open(browser, baseURL, person, width, 844);
    try {
      for (const route of routes(world)) {
        const at = `${route.name} at ${width}`;
        if (route.reach) await route.reach(page);
        else await page.goto(route.path);
        await loaded(page);
        await settled(page);

        expect.soft(await page.getByRole("heading", { level: 1 }).count(), `${at}: one h1`).toBe(1);

        // The header's own: a screen's empty state may offer a second one.
        if (route.back) {
          const back = page.getByRole("main").locator("header").getByRole("link", { name: route.back });
          expect.soft(await back.count(), `${at}: way back in the header`).toBe(1);
        } else {
          const back = page.getByRole("link", { name: /^Volver a / });
          expect.soft(await back.count(), `${at}: no way back`).toBe(0);
        }

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect.soft(scrollWidth, `${at}: no horizontal overflow`).toBeLessThanOrEqual(width);

        if (width === 390) {
          const top = await navBox(page);
          expect.soft(top.bottom, `${at}: tabs in view at the top`).toBeLessThanOrEqual(844);
          expect.soft(top.top, `${at}: tabs at the foot at the top`).toBeGreaterThan(844 - 120);
          await scrollToEnd(page);
          const end = await navBox(page);
          expect.soft(end.bottom, `${at}: tabs in view at the end`).toBeLessThanOrEqual(844);
          expect.soft(end.top, `${at}: tabs at the foot at the end`).toBeGreaterThan(844 - 120);
          const last = await lastControlBottom(page);
          expect.soft(last.count, `${at}: has controls`).toBeGreaterThan(0);
          expect.soft(last.bottom, `${at}: last control above the tabs`).toBeLessThanOrEqual(end.top);
        }

        if (width === 1440) {
          const span = await contentWidth(page);
          const cap = route.form ? FORM_CAP : route.cap;
          if (cap) {
            expect.soft(span, `${at}: content holds the cap`).toBeLessThanOrEqual(cap + TOLERANCE);
            expect.soft(span, `${at}: content draws`).toBeGreaterThan(0);
          } else {
            expect.soft(span, `${at}: content wider than 640`).toBeGreaterThan(640);
          }
        }
      }
    } finally {
      await context.close();
    }
  });
}
