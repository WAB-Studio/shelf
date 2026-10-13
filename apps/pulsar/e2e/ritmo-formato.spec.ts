import type postgres from "postgres";

import roadmap from "../messages/es/roadmap.json";
import { test, expect, visit } from "./fixtures";

// RP-35, module 853: a rhythm text that does not read as time says how to write it;
// a text that reads and falls outside 1 min–744 h says the range. Neither is sent.

const FORMAT = "Escríbelo como 8 h, 1 h 30 min o 90 min.";
const RANGE = "El ritmo va de 1 min a 744 h al mes.";

test.use({ viewport: { width: 390, height: 900 } });

async function seedGoal(db: postgres.Sql, personId: string, rhythm: number | null) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm)
    values (${personId}, ${`Meta formato ${Date.now()}`}, ${`${new Date().getUTCFullYear() + 2}-12-01`}::date, 'minutos', 'minutos', ${rhythm})
    returning id
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
    values (${personId}, ${goal.id}, 'Una', 60, 1, true)
  `;
  return goal.id;
}

async function drop(db: postgres.Sql, personId: string, goalId: string) {
  await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

async function rhythmOf(db: postgres.Sql, goalId: string) {
  const [row] = await db<{ rhythm: number | null }[]>`select rhythm from goals.goals where id = ${goalId}`;
  return row.rhythm;
}

test("the message says how to write a rhythm", () => {
  expect(roadmap.errors.rhythmFormat).toBe(FORMAT);
});

for (const text of ["8 hss", "8 hx", "abc"]) {
  test(`first rhythm: «${text}» says the format, sends nothing and leaves the rhythm null`, async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, null);
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) sent.push(request.url());
    });
    try {
      await visit(page, `/metas/${goalId}/plan`);
      await page.getByPlaceholder("otra").fill(text);
      await page.getByRole("button", { name: "Armar el plan" }).click();
      await expect(page.getByText(FORMAT, { exact: true })).toBeVisible();
      await expect(page.getByText(RANGE, { exact: true })).toHaveCount(0);
      expect(sent).toEqual([]);
      expect(await rhythmOf(db, goalId)).toBeNull();
    } finally {
      await drop(db, personId, goalId);
    }
  });
}

test("the sheet: «8 hx» says the format and the rhythm stays 720", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, 720);
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) sent.push(request.url());
  });
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByRole("button", { name: "Ritmo 12 h al mes" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByPlaceholder("otra").fill("8 hx");
    await sheet.getByRole("button", { name: "Guardar el ritmo" }).click();
    await expect(sheet.getByText(FORMAT, { exact: true })).toBeVisible();
    expect(sent).toEqual([]);
    expect(await rhythmOf(db, goalId)).toBe(720);
  } finally {
    await drop(db, personId, goalId);
  }
});

for (const text of ["0", "745 h"]) {
  test(`first rhythm: «${text}» reads as time and says the range`, async ({ page, db, personId }) => {
    const goalId = await seedGoal(db, personId, null);
    try {
      await visit(page, `/metas/${goalId}/plan`);
      await page.getByPlaceholder("otra").fill(text);
      await page.getByRole("button", { name: "Armar el plan" }).click();
      await expect(page.getByText(RANGE, { exact: true })).toBeVisible();
      await expect(page.getByText(FORMAT, { exact: true })).toHaveCount(0);
      expect(await rhythmOf(db, goalId)).toBeNull();
    } finally {
      await drop(db, personId, goalId);
    }
  });
}

test("first rhythm: «8 hs» saves 480", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, null);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByPlaceholder("otra").fill("8 hs");
    await page.getByRole("button", { name: "Armar el plan" }).click();
    await expect.poll(() => rhythmOf(db, goalId)).toBe(480);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("an empty field with a chip chosen saves the chip, not a format error", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, null);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByRole("radio", { name: "20 h" }).click();
    await page.getByRole("button", { name: "Armar el plan" }).click();
    await expect.poll(() => rhythmOf(db, goalId)).toBe(1200);
    await expect(page.getByText(FORMAT, { exact: true })).toHaveCount(0);
  } finally {
    await drop(db, personId, goalId);
  }
});

test("typing after the format error clears it and brings the preview back", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, null);
  try {
    await visit(page, `/metas/${goalId}/plan`);
    await page.getByPlaceholder("otra").fill("8 hss");
    await page.getByRole("button", { name: "Armar el plan" }).click();
    await expect(page.getByText(FORMAT, { exact: true })).toBeVisible();
    await page.getByPlaceholder("otra").fill("8 h");
    await expect(page.getByText(FORMAT, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^Con 8 h al mes/)).toBeVisible();
  } finally {
    await drop(db, personId, goalId);
  }
});
