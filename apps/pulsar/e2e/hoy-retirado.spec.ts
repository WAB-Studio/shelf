import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// A commitment retired today keeps today's done row when it has today's fact
// (its mark, hour and «lo dijiste tú», undoable as before), asks still
// when it has none (`asksOn` admits its retirement day), and reads on a day before its retirement as it did then
// (RP-13). Quiet stays for a flexible met in its period.

test("a commitment retired today with today's fact stays a done row, one without a fact still asks today", async ({
  person,
  browser,
  db,
}) => {
  test.slow();
  const context = await browser.newContext({ storageState: person.sessionFile });
  const today = todayInZone();
  const ahead = civilDateToDate(today);
  ahead.setUTCDate(ahead.getUTCDate() + 90);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Retirados', ${dateToCivilDate(ahead)}, now() - interval '20 days')
    returning id
  `;
  const insert = async (name: string, kind: string, n: number | null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
      values (${person.id}, ${goal.id}, ${name}, ${kind}, ${n}, 'tap', now() - interval '20 days')
      returning id
    `;
    return row.id;
  };
  const cases = [
    ["Diaria hecha", "daily", null],
    ["Semanal hecha", "times_per_week", 1],
    ["Mensual hecha", "times_per_month", 1],
  ] as const;
  for (const [name, kind, n] of cases) {
    const id = await insert(name, kind, n);
    await db`
      insert into goals.facts (user_id, commitment_id, goal_id, day, written_at)
      values (${person.id}, ${id}, ${goal.id}, ${today}, ${`${today}T07:40:00-05:00`})
    `;
  }
  await insert("Diaria sin hecho", "daily", null);

  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}`);
    for (const name of [...cases.map(([n]) => n), "Diaria sin hecho"]) {
      await page.locator("button", { hasText: name }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Retirarlo" }).click();
      await expect(sheet).toBeHidden();
    }

    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Diaria sin hecho/ })).toBeVisible();
    for (const [name] of cases) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`^${name} .*lo dijiste tú$`) })).toBeVisible();
    }
    await expect(page.getByText("lo dijiste tú")).toHaveCount(3);
    await expect(page.getByText(/cumplida (esta semana|este mes)/)).toHaveCount(0);

    // Undo as before: the row asks again, its fact gone.
    await page.getByRole("button", { name: /^Diaria hecha .*lo dijiste tú$/ }).click();
    await expect(page.getByRole("button", { name: /^Diaria hecha(?! .*lo dijiste tú)/ })).toBeVisible();
    await expect(page.getByText("lo dijiste tú")).toHaveCount(2);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});

test("a commitment retired today reads on a day before as it did then (RP-13)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const today = todayInZone();
  const ahead = civilDateToDate(today);
  ahead.setUTCDate(ahead.getUTCDate() + 90);
  const before = civilDateToDate(today);
  before.setUTCDate(before.getUTCDate() - 1);
  const yesterday = dateToCivilDate(before);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Retirados ayer', ${dateToCivilDate(ahead)}, now() - interval '20 days')
    returning id
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, 'Hecha ayer', 'daily', 'tap', now() - interval '20 days')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, written_at)
    values (${person.id}, ${done.id}, ${goal.id}, ${yesterday}, ${`${yesterday}T08:10:00-05:00`})
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, 'Pendiente ayer', 'daily', 'tap', now() - interval '20 days')
  `;

  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}`);
    for (const name of ["Hecha ayer", "Pendiente ayer"]) {
      await page.locator("button", { hasText: name }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Retirarlo" }).click();
      await expect(sheet).toBeHidden();
    }

    await page.goto(`/dia/${yesterday}`);
    await expect(page.getByText("Hecha ayer", { exact: true })).toBeVisible();
    await expect(page.getByText("Pendiente ayer", { exact: true })).toBeVisible();
    await expect(page.getByText("todos los días · 08:10 · lo dijiste tú", { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
