import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-16 with creation honoured: a goal opened inside the week
// draws no dot and no count on the days before, and a past day that did ask
// still reads "N de M". Each test seeds its own goals and drops them by id.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

function weekdayIndex(day: string): number {
  return (civilDateToDate(day).getUTCDay() + 6) % 7;
}

function longName(day: string): string {
  const date = civilDateToDate(day);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

const today = todayInZone();
const weekDays = Array.from({ length: 7 }, (_, i) => shift(today, i - weekdayIndex(today)));
// Today, or tomorrow when today is Monday: inside the week either way.
const creationDay = weekdayIndex(today) === 0 ? shift(today, 1) : today;
const beforeCreation = weekDays.filter((day) => day < creationDay);
const fromCreation = weekDays.filter((day) => day >= creationDay);
// Noon Bogotá on the civil day: the same civil day in every zone near it.
function noonOf(day: string): Date {
  return new Date(`${day}T17:00:00Z`);
}

async function seedGoal(db: postgres.Sql, personId: string, name: string, createdAt: Date) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${personId}, ${name}, ${shift(today, 60)}) returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.id}, ${`Compromiso ${name}`}, 'daily', 'tap', ${createdAt}) returning id
  `;
  return { goalId: goal.id, commitmentId: commitment.id };
}

test("a goal opened this week asks nothing before it, its mark from then on (RP-16)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Meta creada ${Date.now()}`;
  const { goalId, commitmentId } = await seedGoal(db, personId, name, new Date(Date.now() - 30 * 86_400_000));
  const commitment = `Compromiso ${name}`;
  try {
    await db`
      update goals.commitments set created_at = ${noonOf(creationDay)}
      where id = ${commitmentId} and user_id = ${personId}
    `;
    await page.goto("/semana");
    await expect(page.getByText(name).locator("visible=true").first()).toBeVisible();

    const mark = (day: string) => page.getByRole("img", { name: new RegExp(`^${commitment}, ${longName(day)}: `) });

    for (const day of beforeCreation) {
      await expect(mark(day)).toHaveAccessibleName(`${commitment}, ${longName(day)}: no pedía`);
      await expect(mark(day)).toHaveAttribute("data-state", "none");
    }
    for (const day of fromCreation) {
      await expect(mark(day)).not.toHaveAttribute("data-state", "none");
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("a past day that asked still reads «no hecho», a day to come «todavía no» (RP-06)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Meta con historia ${Date.now()}`;
  const { goalId } = await seedGoal(db, personId, name, new Date(Date.now() - 30 * 86_400_000));
  const commitment = `Compromiso ${name}`;
  try {
    await page.goto("/semana");
    await expect(page.getByText(name).locator("visible=true").first()).toBeVisible();
    for (const day of weekDays) {
      const status = day > today ? "todavía no" : "no hecho";
      await expect(page.getByRole("img", { name: `${commitment}, ${longName(day)}: ${status}` })).toHaveAttribute(
        "data-state",
        "empty",
      );
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
