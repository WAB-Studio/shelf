import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { noonFromToday } from "./reloj";

// A commitment retired today keeps today's done row when it has today's fact
// (its mark, pressed, undoable as before), asks still
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
    for (const name of [...cases.map(([n]) => n), "Diaria sin hecho"]) {
      // A live row is a link to the commitment's own screen, whose «Retirarlo o borrarlo» opens the sheet; the retire lands back on the goal.
      await page.goto(`/metas/${goal.id}`);
      await page.locator("main a", { hasText: name }).click();
      await page.getByRole("button", { name: "Retirarlo o borrarlo", exact: true }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Retirarlo" }).click();
      await expect(sheet).toBeHidden();
    }

    // «Retirarlo» stamps the database's own now(), which a pinned clock does not move.
    await db`update goals.commitments set retired_at = ${noonFromToday(0)} where goal_id = ${goal.id} and user_id = ${person.id}`;

    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Diaria sin hecho/ })).toBeVisible();
    for (const [name] of cases) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-pressed", "true");
    }
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(3);
    await expect(page.getByText(/cumplida (esta semana|este mes)/)).toHaveCount(0);

    // Undo as before: the row asks again, its fact gone.
    await page.getByRole("button", { name: /^Diaria hecha/ }).click();
    await expect(page.getByRole("button", { name: /^Diaria hecha/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(2);
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
    for (const name of ["Hecha ayer", "Pendiente ayer"]) {
      await page.goto(`/metas/${goal.id}`);
      await page.locator("main a", { hasText: name }).click();
      await page.getByRole("button", { name: "Retirarlo o borrarlo", exact: true }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Retirarlo" }).click();
      await expect(sheet).toBeHidden();
    }

    // «Retirarlo» stamps the database's own now(), which a pinned clock does not move.
    await db`update goals.commitments set retired_at = ${noonFromToday(0)} where goal_id = ${goal.id} and user_id = ${person.id}`;

    await page.goto(`/dia/${yesterday}`);
    await expect(page.getByText("Hecha ayer", { exact: true })).toBeVisible();
    await expect(page.getByText("Pendiente ayer", { exact: true })).toBeVisible();
    // Both rows say their cadence now: a marked row no longer swaps it for its hour (decided 2026-10-31).
    await expect(page.getByText("todos los días", { exact: true })).toHaveCount(2);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
