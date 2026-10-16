import type { Browser, Page } from "@playwright/test";

import { test, expect, settled, visit, type Person } from "./fixtures";
import { MINUTES, seedOpenGoal } from "./metas-sin-final-seed";

// Module 974, RP-121 (boards MideQueCuenta 1-4, approved 2026-10-14): the goal and its «Por semana» say what the measure
// counts when the person named it — «mide Cajas embaladas, en cajas», «mide Minutos hablados, en horas y minutos» —
// and say «mide en {unidad}» when the name only repeats the unit. The name is printed as it was written.
// Written from the contract. Every test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const CAJAS = { measure: "Cajas embaladas", unit: "cajas" };

async function open(browser: Browser, baseURL: string | undefined, person: Person, path: string, width = 360) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

const goalPath = (id: string) => `/metas/${id}`;
const weekPath = (id: string) => `/metas/${id}/revision`;
const says = (page: Page, text: string) => page.getByText(text, { exact: true });
const mides = (page: Page) => page.getByText(/^mide /);

// The line, once, and no other «mide …» on the screen.
async function expectOnlyLine(page: Page, text: string) {
  await expect(says(page, text)).toHaveCount(1);
  await expect(says(page, text)).toBeVisible();
  await expect(mides(page)).toHaveCount(1);
}

for (const [label, path] of [["the goal", goalPath], ["«Por semana»", weekPath]] as const) {
  test.describe(`${label} says what the measure counts (RP-121)`, () => {
    test("M1: «Cajas embaladas» in «cajas» reads «mide Cajas embaladas, en cajas», capital as written", async ({ person, browser, baseURL, db }) => {
      // Kills: keeping `goal.detail.measures` / `goal.review.measure` («mide en cajas»); lower-casing the name.
      const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: CAJAS, created: ago(10) });
      const { page, context } = await open(browser, baseURL, person, path(id));
      try {
        await expectOnlyLine(page, "mide Cajas embaladas, en cajas");
        await expect(says(page, "mide en cajas")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("M1: a name written in lower case is printed in lower case", async ({ person, browser, baseURL, db }) => {
      // Kills: capitalising the name; printing a fixed name.
      const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: { measure: "cajas embaladas", unit: "cajas" }, created: ago(10) });
      const { page, context } = await open(browser, baseURL, person, path(id));
      try {
        await expectOnlyLine(page, "mide cajas embaladas, en cajas");
      } finally {
        await context.close();
      }
    });

    test("M2: «Minutos hablados» in minutes reads «mide Minutos hablados, en horas y minutos»", async ({ person, browser, baseURL, db }) => {
      // Kills: forgetting the time branch (the name dropped, or «en minutos»).
      const id = await seedOpenGoal(db, person, { name: "Inglés hablado", unit: { measure: "Minutos hablados", unit: "minutos" }, created: ago(10) });
      const { page, context } = await open(browser, baseURL, person, path(id));
      try {
        await expectOnlyLine(page, "mide Minutos hablados, en horas y minutos");
      } finally {
        await context.close();
      }
    });

    test("M3: a name that only repeats its unit stays silent: «Páginas»/«páginas» reads «mide en páginas»", async ({ person, browser, baseURL, db }) => {
      // Kills: printing `measureName` without `distinctMeasureName` («mide Páginas, en páginas»).
      const id = await seedOpenGoal(db, person, { name: "Leer", unit: { measure: "Páginas", unit: "páginas" }, created: ago(10) });
      const { page, context } = await open(browser, baseURL, person, path(id));
      try {
        await expectOnlyLine(page, "mide en páginas");
      } finally {
        await context.close();
      }
    });

    test("M3: for time, «minutos», «Min» and «Horas» as a name all stay silent: «mide en horas y minutos»", async ({ person, browser, baseURL, db }) => {
      // Kills: `distinctMeasureName` without the unit-word / time-word comparison; a time branch that always prints the name.
      for (const measure of ["minutos", "Min", "Horas"]) {
        const id = await seedOpenGoal(db, person, { name: `Estudio ${measure}`, unit: { measure, unit: MINUTES.unit }, created: ago(10) });
        const { page, context } = await open(browser, baseURL, person, path(id));
        try {
          await expectOnlyLine(page, "mide en horas y minutos");
        } finally {
          await context.close();
        }
      }
    });

    test("M4: a goal measured by its first commitment, stored as the unit «km», reads «mide en km», never «mide Rodaje suave»", async ({ person, browser, baseURL, db }) => {
      // Kills: printing `measureName` without `distinctMeasureName`; reading the name from the first commitment.
      const id = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: { measure: "km", unit: "km" }, created: ago(10) });
      await db`
        insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
        values (${person.id}, ${id}, 'Rodaje suave · 5 km', 'daily', 'quantity', 5, 'km', ${ago(10)})`;
      const { page, context } = await open(browser, baseURL, person, path(id));
      try {
        await expectOnlyLine(page, "mide en km");
        await expect(page.getByText(/mide Rodaje/)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });
  });
}

test("a goal that holds goals carries no name of its own: it reads «mide en km», never a child's name (RP-80)", async ({ person, browser, baseURL, db }) => {
  // Kills: reading the name of a child (or the first one) for the container.
  const holder = await seedOpenGoal(db, person, { name: "Casa", unit: null, created: ago(10) });
  await seedOpenGoal(db, person, { name: "Ruta", parent: holder, unit: { measure: "Zancadas largas", unit: "km" }, created: ago(10) });
  const { page, context } = await open(browser, baseURL, person, goalPath(holder));
  try {
    await expect(says(page, "mide en km")).toBeVisible();
    await expect(page.getByText(/Zancadas largas/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a goal that measures nothing keeps «esta meta no mide nada» and «Ponerle medida», and says no «mide …»", async ({ person, browser, baseURL, db }) => {
  // Kills: drawing a measure line for a goal without a measure.
  const id = await seedOpenGoal(db, person, { name: "Vivir mejor", unit: null, created: ago(10) });
  const { page, context } = await open(browser, baseURL, person, goalPath(id));
  try {
    await expect(says(page, "esta meta no mide nada")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ponerle medida", exact: true })).toBeVisible();
    await expect(mides(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("saving «Cajas embaladas» / «cajas» in «Ponerle medida» makes the goal read «mide Cajas embaladas, en cajas» at once, and so does «Por semana»", async ({ person, browser, baseURL, db }) => {
  // Kills: the sheet saving only the unit; not refreshing; the screen keeping `goal.detail.measures`.
  const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: null, created: ago(3) });
  const { page, context } = await open(browser, baseURL, person, goalPath(id));
  try {
    await page.getByRole("button", { name: "Ponerle medida", exact: true }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("qué cuenta", { exact: true }).fill("Cajas embaladas");
    await sheet.getByLabel("en qué unidad", { exact: true }).fill("cajas");
    await sheet.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(says(page, "mide Cajas embaladas, en cajas")).toBeVisible();
    await visit(page, weekPath(id));
    await expect(says(page, "mide Cajas embaladas, en cajas")).toBeVisible();
  } finally {
    await context.close();
  }
});

async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > 360) bad.push(`scrollWidth ${document.documentElement.scrollWidth}`);
    for (const el of Array.from(document.querySelectorAll("main a[href], main button, main p"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > 360.5) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} right ${r.right}`);
    }
    return bad;
  });
}

test("at 360 the goal and its «Por semana», with the long line «mide Cajas embaladas, en cajas», do not overflow", async ({ person, browser, baseURL, db }) => {
  // Kills: a line that does not wrap; a class drawn outside `components/ui`.
  const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: { measure: "Cajas embaladas de la cocina grande", unit: "cajas" }, created: ago(10) });
  for (const path of [goalPath(id), weekPath(id)]) {
    const { page, context } = await open(browser, baseURL, person, path);
    try {
      await settled(page);
      await expect(says(page, "mide Cajas embaladas de la cocina grande, en cajas")).toBeVisible();
      expect(await overflow(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test("a name that repeats the word the goal prints for its unit stays silent: «búsquedas» over the stored «searches» reads «mide en búsquedas»", async ({ person, browser, baseURL, db }) => {
  // Kills: `distinctMeasureName` on the goal without the printed unit word among its comparisons («mide búsquedas, en búsquedas»).
  const id = await seedOpenGoal(db, person, { name: "Investigar", unit: { measure: "búsquedas", unit: "searches" }, created: ago(10) });
  const { page, context } = await open(browser, baseURL, person, goalPath(id));
  try {
    await expectOnlyLine(page, "mide en búsquedas");
    await expect(page.getByText(/mide búsquedas/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
