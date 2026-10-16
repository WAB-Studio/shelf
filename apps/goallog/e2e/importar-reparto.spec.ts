import type { Page } from "@playwright/test";

import { placeLeftovers } from "../lib/import/coverage";
import { normalize, type Correction } from "../lib/import/draft";
import { linesToTasks } from "../lib/import/line-tasks";
import { todayInZone } from "../lib/zone";
import { test, expect, settled } from "./fixtures";
import { asPerson, createButton, rawGoal, rawTask, seedOf, stored, unfold } from "./importar-plan";

// 903c: a second pass sends the tasks of a general goal to the goal below that serves them, and a line
// shaped like a task is a task. Each is one correction the person can decline.

const KEY = "pulsar.import-draft";
const decline = (page: Page) => page.getByRole("button", { name: "Dejar como estaba" });

async function open(page: Page, value: unknown) {
  await page.goto("/metas/importar");
  await page.evaluate(([key, text]) => sessionStorage.setItem(key, text), [KEY, JSON.stringify(value)] as const);
  await page.goto("/metas/importar/revisar");
  await settled(page);
  await unfold(page);
}

function movedSeed() {
  const seed = seedOf([
    rawGoal("Carrera", { key: "g", tasks: [rawTask("Wireframes del caso"), rawTask("Anki diario")] }),
    rawGoal("Caso #1", { key: "c1", parent: "g" }),
  ]);
  const value = stored(seed);
  const move: Correction = {
    id: "goals.0.tasks.0:taskMoved",
    at: "goals.0.tasks.0",
    code: "taskMoved",
    said: "Carrera",
    proposed: "Caso #1",
    values: { to: "c1", name: "Wireframes del caso" },
    declined: "keepsPlan",
  };
  value.corrections.push(move);
  return value;
}

test.describe("a task the second pass moved (903c)", () => {
  test("it is drawn under the goal it went to with one correction that says from where and to where; creating writes it there", async ({ person, browser, baseURL, db }) => {
    // Kills: a move applied with no correction to reject, or one that writes the task where the plan had it.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page, movedSeed());
      await expect(page.getByText("En «Carrera»", { exact: true })).toBeVisible();
      await expect(page.getByText("En «Caso #1»", { exact: true })).toBeVisible();
      await expect(page.getByText("«Wireframes del caso» sirve a una de las metas de abajo, no a «Carrera» entera.")).toBeVisible();
      await expect(decline(page)).toHaveCount(1);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await db`select o.name, g.name as goal from goals.one_offs o join goals.goals g on g.id = o.goal_id where o.user_id = ${person.id} order by o.name`;
      expect(rows.map((r) => [r.name, r.goal])).toEqual([["Anki diario", "Carrera"], ["Wireframes del caso", "Caso #1"]]);
    });
  });

  test("declining leaves the task in the general goal, says so, can be taken back, and what is written follows", async ({ person, browser, baseURL, db }) => {
    // Kills: a decline that does nothing, or one that cannot be undone.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page, movedSeed());
      await decline(page).click();
      await expect(page.getByText("Se queda como decía el plan: Carrera.")).toBeVisible();
      await expect(decline(page)).toHaveCount(0);
      await page.reload();
      await settled(page);
      await unfold(page);
      await expect(page.getByText("Se queda como decía el plan: Carrera.")).toBeVisible();
      await page.getByRole("button", { name: "Aceptar la corrección" }).click();
      await unfold(page);
      await expect(page.getByText("En «Caso #1»", { exact: true })).toBeVisible();
      await decline(page).click();
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await db`select o.name, g.name as goal from goals.one_offs o join goals.goals g on g.id = o.goal_id where o.user_id = ${person.id} order by o.name`;
      expect(rows.map((r) => [r.name, r.goal])).toEqual([["Anki diario", "Carrera"], ["Wireframes del caso", "Carrera"]]);
    });
  });
});

test.describe("a line shaped like a task (903c)", () => {
  function lineSeed() {
    const lines = ["# Reglas", "- [ ] Llamar al banco", "Sin empleo antes de abril."];
    const source = { kind: "lines" as const, lines };
    const { draft, corrections } = normalize({ goals: [rawGoal("Reglas", { key: "r", src: [{ from: 1, to: 1 }] })] }, source);
    const lined = linesToTasks(placeLeftovers(draft, source), source, todayInZone(), { onlyDone: false });
    return { ...stored(seedOf([], { source })), draft: lined.draft, corrections: [...corrections, ...lined.corrections], source };
  }

  test("it is a task with a correction that says it left the note; creating writes the task and not the line", async ({ person, browser, baseURL, db }) => {
    // Kills: a task-shaped line left in the note, or turned into a task with no say from the person.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page, lineSeed());
      await expect(page.getByText("En la nota: «Llamar al banco»", { exact: true })).toBeVisible();
      await expect(page.getByText("Tarea: «Llamar al banco»", { exact: true })).toBeVisible();
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [goal] = await db`select id, note from goals.goals where user_id = ${person.id} and name = 'Reglas'`;
      expect(goal.note).toBe("Sin empleo antes de abril.");
      const tasks = await db`select name from goals.one_offs where goal_id = ${goal.id}`;
      expect(tasks.map((t) => t.name)).toEqual(["Llamar al banco"]);
    });
  });

  test("declining puts the line back in the note and takes the task out", async ({ person, browser, baseURL, db }) => {
    // Kills: a decline that keeps both the task and the line, or loses the line.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await open(page, lineSeed());
      await decline(page).click();
      await expect(page.getByText("Se queda como decía el plan: Llamar al banco.")).toBeVisible();
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [goal] = await db`select id, note from goals.goals where user_id = ${person.id} and name = 'Reglas'`;
      expect(goal.note).toBe("Sin empleo antes de abril.\nLlamar al banco");
      expect(await db`select 1 from goals.one_offs where goal_id = ${goal.id}`).toHaveLength(0);
    });
  });
});
