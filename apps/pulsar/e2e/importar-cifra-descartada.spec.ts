import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect, settled as pageSettled } from "./fixtures";
import { todayInZone } from "../lib/zone";
import { rawGoal, rawTask, seedOf, stored, unfold } from "./importar-plan";

// 689 (1): a figure falls for a reason, and the review says the true one. In a goal
// measured in something that is not time the reason is «esta meta no mide tiempo»;
// «no mide nada» is for the goal with no measure.

const NOT_TIME = messages.notices.estimateDroppedNotTime;
const NOTHING = messages.notices.estimateDropped;
const [year, month] = todayInZone().split("-").map(Number);
const first = `${year}-${String(month).padStart(2, "0")}`;
const horizon = `${year + 1}-${String(month).padStart(2, "0")}-01`;
const monthWord = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("es", { month: "long", timeZone: "UTC" });

// The reader gives a goal with no measure its hours when a task carries a figure, so the figure
// the review drops reaches it only from a draft that skipped that step: the tab's storage holds one.
const goal = (name: string, measure: { name: string; unit: string } | null, tasks: { name: string; estimate: number | null; children: { name: string; estimate: number | null }[] }[]) =>
  rawGoal(name, {
    horizon,
    measure,
    tasks: tasks.map((task) => rawTask(task.name, { month: first, estimate: task.estimate, children: task.children.map((child) => ({ name: child.name, estimate: child.estimate, rule: null, noteSrc: [], noteText: null, src: [] })) })),
  });

async function toOpenReview(page: Page) {
  const seeded = stored(
    seedOf([
      goal("Correr", { name: "distancia", unit: "km" }, [
        { name: "Salir a correr", estimate: 5, children: [] },
        { name: "Plan semanal", estimate: null, children: [{ name: "Rodaje largo", estimate: 2 }] },
      ]),
      goal("Trámites", { name: "tiempo", unit: "minutos" }, [
        { name: "Comprar tenis", estimate: 2, children: [] },
        { name: "Papeles", estimate: null, children: [{ name: "Pedir cita", estimate: 1 }] },
      ]),
    ]),
  );
  seeded.draft.goals[1].measure = null;
  seeded.corrections = [];
  await page.goto("/metas/importar");
  await expect(page.getByRole("button", { name: "Leer el plan" })).toBeVisible();
  await page.evaluate((value) => sessionStorage.setItem("pulsar.import-draft", value), JSON.stringify(seeded));
  await page.goto("/metas/importar/revisar");
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await pageSettled(page);
  await unfold(page);
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
      await toOpenReview(page);
      for (const fold of await page.getByRole("button", { name: "1 sub-tarea" }).all()) await fold.click();

      // The task says its month and the reason; the sub-task its own class and the same reason.
      await expect(page.getByText(`tarea · ${monthWord} · ${NOT_TIME}`, { exact: true })).toHaveCount(1);
      await expect(page.getByText(`sub-tarea · ${monthWord} · ${NOT_TIME}`, { exact: true })).toHaveCount(1);
      await expect(page.getByText(NOT_TIME)).toHaveCount(2);

      await expect(page.getByText(`tarea · ${monthWord} · ${NOTHING}`, { exact: true })).toHaveCount(1);
      await expect(page.getByText(`sub-tarea · ${monthWord} · ${NOTHING}`, { exact: true })).toHaveCount(1);
      await expect(page.getByText(NOTHING)).toHaveCount(2);

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
