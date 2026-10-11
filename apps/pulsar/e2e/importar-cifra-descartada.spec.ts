import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled as pageSettled } from "./fixtures";
import { todayInZone } from "../lib/zone";

// 689 (1): a figure falls for a reason, and the review says the true one. In a goal
// measured in something that is not time the reason is «esta meta no mide tiempo»;
// «no mide nada» is for the goal with no measure.

const NOT_TIME = messages.notices.estimateDroppedNotTime;
const NOTHING = messages.notices.estimateDropped;
const [year, month] = todayInZone().split("-").map(Number);
const first = `${year}-${String(month).padStart(2, "0")}`;
const horizon = `${year + 1}-${String(month).padStart(2, "0")}-01`;
const monthWord = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("es", { month: "long", timeZone: "UTC" }) + ` ${year}`;

// The template refuses a figure on a task of a goal that is not measured in time (RP-72), so
// this draft reaches the review as the model's would: through the tab's storage.
const goal = (name: string, measure: { name: string; unit: string } | null, tasks: { name: string; estimate: number | null; children: { name: string; estimate: number | null }[] }[]) => ({
  name,
  horizon,
  measure,
  rhythm: null,
  phases: [],
  months: [],
  commitments: [],
  tasks: tasks.map((task) => ({ month: first, ...task })),
});
const draft = {
  goals: [
    goal("Correr", { name: "distancia", unit: "km" }, [
      { name: "Salir a correr", estimate: 5, children: [] },
      { name: "Plan semanal", estimate: null, children: [{ name: "Rodaje largo", estimate: 2 }] },
    ]),
    goal("Trámites", null, [
      { name: "Comprar tenis", estimate: 2, children: [] },
      { name: "Papeles", estimate: null, children: [{ name: "Pedir cita", estimate: 1 }] },
    ]),
  ],
};

async function toReview(page: Page) {
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.evaluate(
    (stored) => sessionStorage.setItem("pulsar.import-draft", JSON.stringify(stored)),
    { via: "model", draft, source: null, sourceName: null, unmarked: null },
  );
  await page.goto("/metas/importar/revisar");
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
}

type Fixtures = { person: { id: string; sessionFile: string }; browser: Browser; baseURL: string | undefined };

for (const width of [360, 1440]) {
  test(`@${width}: a task and a sub-task in a goal measured in km say «no mide tiempo»; with no measure they say «no mide nada»`, async ({
    person,
    browser,
    baseURL,
    db,
  }: Fixtures & { db: import("postgres").Sql }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 1400 } });
    const page = await context.newPage();
    try {
      await toReview(page);
      const km = page.getByRole("region", { name: "Correr" });
      const bare = page.getByRole("region", { name: "Trámites" });

      await expect(km.getByText(`${monthWord} · ${NOT_TIME}`, { exact: true })).toBeVisible();
      // The sub-task carries the bare reason; the task, its month before it.
      await expect(km.getByText(NOT_TIME, { exact: true })).toHaveCount(1);
      await expect(km.getByText(NOT_TIME)).toHaveCount(2);
      await expect(km.getByText(NOTHING)).toHaveCount(0);

      await expect(bare.getByText(`${monthWord} · ${NOTHING}`, { exact: true })).toBeVisible();
      await expect(bare.getByText(NOTHING, { exact: true })).toHaveCount(1);
      await expect(bare.getByText(NOTHING)).toHaveCount(2);
      await expect(bare.getByText(NOT_TIME)).toHaveCount(0);

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // The reason is only said: the task is still made, without the figure.
      await page.getByRole("button", { name: "Crear 2 metas" }).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await db`
        select name, estimate from goals.one_offs
        where user_id = ${person.id} and name in ('Salir a correr', 'Rodaje largo', 'Comprar tenis', 'Pedir cita')`;
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row.estimate).toBeNull();
    } finally {
      await db`delete from goals.goals where user_id = ${person.id} and name in ('Correr', 'Trámites')`;
      await context.close();
    }
  });
}
