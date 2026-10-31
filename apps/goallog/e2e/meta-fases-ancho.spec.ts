import type postgres from "postgres";

import { horizonForWeeks } from "@/lib/day/weeks";
import { civilDateInZone } from "@/lib/zone";

import { test, expect, openMore } from "./fixtures";
import goalMessages from "../messages/es/goal.json";
import { boxOf } from "./box";

// From 1024 the goal's phases stand under the two columns at the
// content's full width; a phase stored before its goal opened reads from week
// 1; the lines under the title and beside a name are Archivo with mono figures;
// «Renombrar» on the phone spans the column.

const AIM = "Desbloquear la boca con una frase larga que antes se partía en una palabra por línea";

async function seedGoal(db: postgres.Sql, personId: string, name: string, phaseFrom?: string) {
  const createdAt = new Date(Date.now() - 2 * 86_400_000);
  const openedOn = civilDateInZone(createdAt);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizonForWeeks(openedOn, 12)}, ${createdAt})
    returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${personId}, ${goal.id}, 'Compromiso ancho', 'daily', 'tap')
  `;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${personId}, ${goal.id}, ${AIM}, ${phaseFrom ?? openedOn}, ${openedOn})
  `;
  return goal.id;
}

test("at 1024 the phases card is 600 wide and its aim takes 2 lines at most; at 1440 it starts where the commitments do", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, `Meta fases ${Date.now()}`);
  try {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(AIM, { exact: true })).toBeVisible();
    const card = await page.getByText(AIM, { exact: true }).evaluate((el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.borderTopWidth === "1px" && style.borderTopLeftRadius === "14px") {
          return node.getBoundingClientRect().width;
        }
      }
      return 0;
    });
    expect(card).toBeGreaterThanOrEqual(600);
    const lines = await page.getByText(AIM, { exact: true }).evaluate((el) => {
      const { height } = el.getBoundingClientRect();
      return height / parseFloat(getComputedStyle(el).lineHeight);
    });
    expect(Math.round(lines)).toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(AIM, { exact: true })).toBeVisible();
    const phasesLabel = await page.getByText(/^Una fase$/).evaluate((el) => el.getBoundingClientRect().left);
    const commitments = await page.getByText(/^Un compromiso$/).evaluate((el) => el.getBoundingClientRect().left);
    expect(Math.abs(phasesLabel - commitments)).toBeLessThanOrEqual(1);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a phase from before the goal opened reads «semanas 1–…», its span in Archivo with mono figures", async ({
  page,
  db,
  personId,
}) => {
  const before = civilDateInZone(new Date(Date.now() - 20 * 86_400_000));
  const goalId = await seedGoal(db, personId, `Meta fase vieja ${Date.now()}`, before);
  try {
    await page.goto(`/metas/${goalId}`);
    const span = page.getByText(/^semanas \d/);
    await expect(span).toBeVisible();
    await expect(span).toHaveText(/^semanas 1–/);
    const family = await span.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).not.toMatch(/mono/i);
    const figure = await span.locator("span").first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(figure).toMatch(/mono/i);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("the line under the title is Archivo with its date in mono, and a commitment's satisfaction is Archivo", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, `Meta linea ${Date.now()}`);
  try {
    await page.goto(`/metas/${goalId}`);
    const line = page.getByText(/^meta · abierta el /);
    await expect(line).toBeVisible();
    expect(await line.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
    expect(await line.locator("span").first().evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i);
    const tap = page.getByText(goalMessages.satisfaction.tap, { exact: true });
    expect(await tap.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("at 390 «Renombrar» spans the column", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, `Meta renombrar ${Date.now()}`);
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/metas/${goalId}`);
    await openMore(page);
    const rename = page.getByRole("button", { name: "Renombrar" });
    await expect(rename).toBeVisible();
    const box = (await boxOf(rename));
    const header = (await boxOf(page.getByRole("heading", { level: 1 })));
    expect(box.width).toBeGreaterThanOrEqual(header.width - 1);
    expect(box.width).toBeGreaterThan(300);
    // An outlined block, never the ghost that floats centred on the phone.
    expect(await rename.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a phase wholly before the goal opened never reads a week below 1: «semanas 1–1»", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, `Meta fase pasada ${Date.now()}`);
  try {
    await db`
      update goals.phases set starts_on = ${civilDateInZone(new Date(Date.now() - 40 * 86_400_000))},
                              ends_on = ${civilDateInZone(new Date(Date.now() - 30 * 86_400_000))}
      where goal_id = ${goalId} and user_id = ${personId}
    `;
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText(/^semanas \d/)).toHaveText("semanas 1–1");
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
