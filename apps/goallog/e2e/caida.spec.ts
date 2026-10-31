import { test, expect } from "./fixtures";
import chat from "../messages/es/chat.json";
import connections from "../messages/es/connections.json";
import day from "../messages/es/day.json";
import exportCatalog from "../messages/es/export.json";
import goal from "../messages/es/goal.json";
import habit from "../messages/es/habit.json";
import importCatalog from "../messages/es/import.json";
import oneOffs from "../messages/es/oneOffs.json";
import plan from "../messages/es/plan.json";
import week from "../messages/es/week.json";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// Against `PULSAR_DOWN_BASE_URL`: a `next start` of the same build whose
// `DATABASE_URL` points at a port nothing listens on, so the outage is real
// and the app carries no lever for it. Assert by heading, never by status:
// a route that has streamed answers 200 whatever it then draws
// (docs/TRAPS.md, "A `notFound()` after the page has streamed still answers 200").
const DOWN = process.env.PULSAR_DOWN_BASE_URL;
const LIVE = process.env.PULSAR_BASE_URL ?? "http://localhost:3200";

// A uuid nobody owns.
const GHOST = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

test.describe("a database outage", () => {
  test.skip(!DOWN, "PULSAR_DOWN_BASE_URL unset: no server with an unreachable database to drive");

  for (const path of [
    `/metas/${GHOST}`,
    `/metas/${GHOST}/fases/nueva`,
    `/metas/${GHOST}/compromisos/nuevo`,
    `/metas/${GHOST}/revision`,
    "/",
  ]) {
    test(`${path} draws the failure page, not the not-found`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Intentar otra vez" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
    });
  }

  test("/ keeps the nav: the outage lands under the layout, not in global-error", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
    await expect(page.getByRole("navigation")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
  });

  test("at 1280 the rail draws its four tabs and no goal section when the goals read fails", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const nav = page.getByRole("navigation");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(4);
    await expect(nav.getByText("Metas abiertas", { exact: true })).toHaveCount(0);
  });

  for (const width of [390, 1440]) {
    test(`at ${width} the failure on /mes marks Mes and draws its exit as the board does`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/mes");
      await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
      await expect(page.locator("a[aria-current]")).toHaveCount(1);
      await expect(page.getByRole("navigation").getByRole("link", { name: "Mes" })).toHaveAttribute(
        "aria-current",
        "page",
      );

      const retry = await page.getByRole("button", { name: "Intentar otra vez" }).boundingBox();
      const home = await page.getByRole("main").getByRole("link", { name: "Ir a hoy" }).boundingBox();
      const main = await page.getByRole("main").boundingBox();
      if (width >= 1024) {
        expect(Math.abs(retry!.y - home!.y)).toBeLessThanOrEqual(1);
        expect(home!.x).toBeGreaterThan(retry!.x + retry!.width - 1);
        expect(home!.x + home!.width - retry!.x).toBeLessThanOrEqual(560);
      } else {
        expect(home!.y).toBeGreaterThan(retry!.y + retry!.height - 1);
        expect(retry!.width).toBeCloseTo(home!.width, 0);
        expect(retry!.width).toBeGreaterThan(main!.width - 64);
      }
    });
  }

  test("Intentar otra vez asks the server again", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ir a hoy" })).toHaveAttribute("href", "/");
    await expect(page.getByRole("link", { name: /^Volver a / })).toHaveCount(0);

    // `retry()` re-fetches the boundary's children with an `rsc` header; a
    // `Link` prefetch carries it too, so the prefetch header is excluded.
    const refetch = page.waitForRequest(async (request) => {
      if (new URL(request.url()).origin !== new URL(DOWN ?? "").origin) return false;
      const headers = await request.allHeaders();
      return headers["rsc"] === "1" && headers["next-router-prefetch"] === undefined;
    });
    await page.getByRole("button", { name: "Intentar otra vez" }).click();
    await refetch;

    await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
  });

  // The pool's reconnect backoff decides how soon a retried page redraws: with
  // the default (up to 20 s) the third or fourth press sits on the skeleton.
  // Each press must have the failure heading back within this bound.
  const REDRAW_MS = 3000;

  test("pressing Intentar otra vez five times in a row redraws the failure each time, fast", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
    const again = page.getByRole("button", { name: "Intentar otra vez" });

    for (let press = 1; press <= 5; press += 1) {
      const refetched = page.waitForResponse(
        (response) =>
          new URL(response.url()).origin === new URL(DOWN ?? "").origin &&
          response.request().headers()["rsc"] === "1" &&
          response.request().headers()["next-router-prefetch"] === undefined,
      );
      const started = Date.now();
      await again.click();
      await refetched;
      await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible({ timeout: REDRAW_MS });
      await expect(again).toBeVisible({ timeout: REDRAW_MS });
      expect(Date.now() - started, `press ${press} took too long to redraw`).toBeLessThan(REDRAW_MS);
    }
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
  });

  test("the live server draws the not-found for a goal nobody owns", async ({ page }) => {
    await page.goto(`${LIVE}/metas/${GHOST}`);
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toHaveCount(0);
  });

  // Every page that reads the database throws on an outage: the failure
  // page is its only state, never its empty state or the not-found.
  const today = todayInZone();
  const shiftDay = (day: string, by: number) => {
    const date = civilDateToDate(day);
    date.setUTCDate(date.getUTCDate() + by);
    return dateToCivilDate(date);
  };
  const yesterday = shiftDay(today, -1);
  const month = today.slice(0, 7);
  const pastMonday = () => {
    const date = civilDateToDate(today);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) - 14);
    return dateToCivilDate(date);
  };

  const reads: { path: string; empty: (string | RegExp)[] }[] = [
    { path: "/semana", empty: [week.empty.title] },
    { path: `/semana?semana=${pastMonday()}`, empty: [week.empty.title] },
    { path: "/sueltas", empty: [oneOffs.empty] },
    { path: "/metas", empty: [goal.none.title, goal.none.body] },
    { path: "/exportar", empty: [exportCatalog.empty] },
    { path: "/conexiones", empty: [connections.sections.first, connections.intro] },
    { path: `/dia/${yesterday}`, empty: [day.past.nothingTitle] },
    { path: `/metas/${GHOST}/meses`, empty: [/ no tiene tareas\./] },
    { path: `/metas/${GHOST}/meses/${month}`, empty: [/ no tiene tareas\./] },
    { path: `/metas/${GHOST}/meses/${month}/tarea/nueva`, empty: [/ no tiene tareas\./] },
    { path: `/metas/${GHOST}/plan`, empty: [/ no tiene tareas\./] },
    { path: `/metas/habitos/${GHOST}`, empty: [habit.months.title] },
    { path: "/metas/importar/revisar", empty: [importCatalog.review.title] },
  ];

  for (const { path, empty } of reads) {
    test(`${path} draws the failure with both exits, never its empty state`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Intentar otra vez" })).toBeVisible();
      await expect(page.getByRole("main").getByRole("link", { name: "Ir a hoy" })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Volver a / })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Esta página no existe" })).toHaveCount(0);
      await expect(page.getByRole("navigation")).toBeVisible();
      for (const text of empty) await expect(page.getByText(text)).toHaveCount(0);
    });
  }

  // These four read nothing to draw: the form opens in an outage and the
  // failure arrives on save.
  const forms: { path: string; title: string }[] = [
    { path: "/metas/nueva", title: goal.new.title },
    { path: "/metas/habitos/nuevo", title: plan.habitForm.title },
    { path: "/chat", title: chat.title },
    { path: "/metas/importar", title: importCatalog.title },
  ];

  for (const { path, title } of forms) {
    test(`${path} draws its form in an outage`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole("main").getByRole("button").or(page.getByRole("main").getByRole("textbox")).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "No se pudo abrir" })).toHaveCount(0);
    });
  }

  test("/metas at 1280 keeps the rail with its four tabs around the failure", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/metas");
    await expect(page.getByRole("main").getByRole("heading", { name: "No se pudo abrir" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(4);
    await expect(page.getByText(goal.none.title)).toHaveCount(0);
  });

  test("the import template downloads in an outage", async ({ request }) => {
    const response = await request.get(`${DOWN}/importar/plantilla.xlsx`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("spreadsheetml.sheet");
  });
});
