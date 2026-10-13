import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import {
  BIG,
  GENERAL,
  GENERAL_NOTE_1,
  GENERAL_NOTE_2,
  SMALL,
  SUB_A,
  SUB_B,
  TASK_A,
  WEEK,
  WEEK_NOTE,
  asPerson,
  createButton,
  months,
  planText,
  toOpenReview,
} from "./importar-plan";

// Creating the plan (RP-86, RP-88, RP-90, RP-95): what is written is what the review shows, and
// nothing is written before «Crear». The boards are `ImportarCreando` and `ImportarCrearFallo`.

test.describe("«Crear» writes the tree the person left (RP-90, RP-95)", () => {
  test("under a rhythm the tasks are written into the plan, with no month (RP-67)", async ({ person, browser, baseURL, db }) => {
    // Kills: writing the task's month for a goal that has a rhythm.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText());
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const tasks = await db`select name, in_plan, planned_month::text as month from goals.one_offs where user_id = ${person.id} and parent_id is null`;
      expect(tasks.length).toBeGreaterThan(0);
      for (const task of tasks) {
        expect(task.in_plan).toBe(true);
        expect(task.month).toBeNull();
      }
    });
  });

  test("three levels go to /metas with their parents and notes; a sub-task left out and a month changed are not what was written", async ({ person, browser, baseURL, db }) => {
    // Kills: creating without `parent`, dropping a note, or writing what the person unmarked.
    const { first } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      // No `ritmo:` line: under a rhythm the tasks go to the plan and carry no month (RP-67).
      await toOpenReview(page, planText({ rhythm: false }));
      await page.getByRole("button", { name: "2 sub-tareas" }).click();
      await page.getByRole("checkbox", { name: new RegExp(`^${SUB_B}`) }).uncheck();
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
      await expect(createButton(page)).toHaveText("Crear 3 metas");

      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      await expect(page.getByText(GENERAL).first()).toBeVisible();

      const goals = await db`select id, name, parent_id, note from goals.goals where user_id = ${person.id}`;
      const by = (name: string) => goals.find((g) => g.name === name)!;
      expect(goals).toHaveLength(3);
      expect(by(GENERAL).parent_id).toBeNull();
      expect(by(BIG).parent_id).toBe(by(GENERAL).id);
      expect(by(SMALL).parent_id).toBe(by(BIG).id);
      expect(by(GENERAL).note).toBe(`${GENERAL_NOTE_1}\n${GENERAL_NOTE_2}`);

      const tasks = await db`select id, name, note, parent_id, planned_month::text as month from goals.one_offs where user_id = ${person.id}`;
      const week = tasks.find((t) => t.name === WEEK)!;
      expect(week.note).toBe(WEEK_NOTE);
      expect(week.month).toBe(`${first}-01`);
      expect(tasks.filter((t) => t.parent_id === week.id).map((t) => t.name)).toEqual([SUB_A]);
      expect(tasks.some((t) => t.name === SUB_B)).toBe(false);
      expect(tasks.some((t) => t.name === TASK_A)).toBe(true);
    });
  });

  test("while it creates, the tree stands still, the button says «Creando…», and a second tap creates nothing more", async ({ person, browser, baseURL, db }) => {
    // Kills: leaving the button live while the call runs (two plans written).
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText());
      let calls = 0;
      await page.route("**/metas/importar/revisar", async (route) => {
        if (route.request().method() === "POST") {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        await route.continue();
      });
      await createButton(page).click();
      const busy = page.getByRole("button", { name: messages.review.creating });
      await expect(busy).toBeDisabled();
      await expect(busy).toHaveAttribute("aria-busy", "true");
      for (const checkbox of await page.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
      await busy.click({ force: true });
      await expect(page).toHaveURL(/\/metas$/);
      expect(calls).toBe(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(3);
    });
  });

  test("a failed create leaves the tree and its marks, says so, and the same button tries again", async ({ person, browser, baseURL, db }) => {
    // Kills: clearing the draft when the call fails.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText());
      await page.getByRole("checkbox", { name: new RegExp(`^${TASK_A}`) }).uncheck();
      await page.route("**/metas/importar/revisar", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
      await createButton(page).click();
      await expect(page.getByText(messages.review.failed, { exact: true })).toBeVisible();
      await expect(createButton(page)).toBeEnabled();
      await expect(page.getByRole("checkbox", { name: new RegExp(`^${TASK_A}`) })).not.toBeChecked();
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);

      await page.reload();
      await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: new RegExp(`^${GENERAL}`) })).toBeVisible();

      await page.unroute("**/metas/importar/revisar");
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(3);
    });
  });
});
