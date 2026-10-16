import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `TareaNota`, `TareaNotaEscribiendo`, `TareaNotaGuardada`, `TareaNotaHecha`,
// `TareaNotaFallo`, `TareaNotaLarga`, `TareaNotaVaciar` (RP-45):
// the note of a task, on a goal's month and on «Mes», at 360px.

const today = todayInZone();
const thisMonth = monthOf(today);
const seg = thisMonth.slice(0, 7);
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

type Db = import("postgres").Sql;

async function seed(db: Db, personId: string, stamp: number, done: boolean) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${`Meta nota ${stamp}`}, ${horizon}::date, now() - interval '3 days')
    returning id
  `;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${personId}, ${goal.id}, ${`Tarea nota ${stamp}`}, ${thisMonth}::date)
    returning id
  `;
  if (done) {
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${personId}, ${goal.id}, ${task.id}, ${today}::date)
    `;
  }
  return { goalId: goal.id, taskId: task.id, name: `Tarea nota ${stamp}` };
}

async function noteOf(db: Db, taskId: string): Promise<string | null> {
  const [row] = await db<{ note: string | null }[]>`select note from goals.one_offs where id = ${taskId}`;
  return row.note;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
}

for (const screen of ["goal", "across"] as const) {
  test(`${screen}: a note with a line break saves, reads on the row after reload, and is emptied (RP-45)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const { goalId, taskId, name } = await seed(db, person.id, stamp, false);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width: 360, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto(screen === "goal" ? `/metas/${goalId}/meses/${seg}` : "/mes");

      await page.getByRole("button", { name: `Escribir una nota en «${name}»` }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name })).toBeVisible();
      await expect(sheet).toContainText(`nota · Meta nota ${stamp}`);
      await expect(sheet.getByRole("button", { name: "quitar la nota" })).toHaveCount(0);
      await sheet.getByLabel("nota", { exact: true }).fill("primera línea\nsegunda línea");
      await sheet.getByRole("button", { name: "Guardar" }).click();
      await expect(sheet).toBeHidden();
      expect(await noteOf(db, taskId)).toBe("primera línea\nsegunda línea");

      await page.reload();
      await expect(page.getByText("primera línea")).toBeVisible();
      await expect(page.getByText("segunda línea")).toBeVisible();
      await noOverflow(page);

      // Emptied: the row draws as with no note.
      await page.getByRole("button", { name: `Ver la nota de «${name}»` }).click();
      await page.getByRole("dialog").getByRole("button", { name: "quitar la nota" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      expect(await noteOf(db, taskId)).toBeNull();
      await page.reload();
      await expect(page.getByText("primera línea")).toHaveCount(0);
      await expect(page.getByRole("button", { name: `Escribir una nota en «${name}»` })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test("the mark still completes in one tap and the name opens the task's sheet, never the delete one; a done task's note saves (RP-45)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const { goalId, taskId, name } = await seed(db, person.id, stamp, false);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/meses/${seg}`);
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name })).toBeVisible();
    await expect(page.getByRole("dialog")).not.toContainText("¿Borrarla?");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Marcar como hecho" }).click();
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();

    await page.getByRole("button", { name: `Escribir una nota en «${name}»` }).click();
    await page.getByRole("dialog").getByLabel("nota", { exact: true }).fill("ya hecha");
    await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await noteOf(db, taskId)).toBe("ya hecha");
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();
    await expect(page.getByText("ya hecha")).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
});

test("2001 characters show the refusal and keep the text; a failed save keeps the text and retries (RP-45)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const { goalId, taskId, name } = await seed(db, person.id, stamp, false);
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/meses/${seg}`);
    await page.getByRole("button", { name: `Escribir una nota en «${name}»` }).click();
    const sheet = page.getByRole("dialog");
    const area = sheet.getByLabel("nota", { exact: true });

    const long = "a".repeat(2001);
    await area.fill(long);
    await expect(sheet.getByRole("alert")).toHaveText("Es muy larga. Escribe máximo 2000 caracteres.");
    await expect(sheet.getByText("2 001 de 2000")).toBeVisible();
    await expect(area).toHaveValue(long);
    await expect(sheet.getByRole("button", { name: "Guardar" })).toBeDisabled();
    expect(await noteOf(db, taskId)).toBeNull();

    // A refused act: every server action POST fails once.
    await area.fill("texto que no se pierde");
    let refuse = true;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (refuse && request.method() === "POST" && request.headers()["next-action"]) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "No se pudo guardar. Tu texto sigue aquí; inténtalo otra vez.",
    );
    await expect(area).toHaveValue("texto que no se pierde");
    expect(await noteOf(db, taskId)).toBeNull();

    refuse = false;
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, taskId)).toBe("texto que no se pierde");
  } finally {
    await context.close();
  }
});
