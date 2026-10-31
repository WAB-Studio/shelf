import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";
import plan from "../messages/es/plan.json";
import { seedFact } from "./sin-final-seed";

// M17 (RNP-03, RP-15, RP-55): «Nueva tarea», «Nueva fase», «Editar fase» and «Editar compromiso» read one goal's
// form (`loadGoalForm`), not its whole history. Each form draws what it drew; the refusals stand.

const thisMonth = monthOf(todayInZone());
const horizon = nextMonth(nextMonth(thisMonth));
const seg = thisMonth.slice(0, 7);
const missing = (page: import("@playwright/test").Page) => page.getByRole("heading", { name: "Esta página no existe" });

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string, extra: { archived?: boolean; horizon?: string } = {}) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at, archived_at)
    values (${personId}, ${name}, ${extra.horizon ?? horizon}::date, 'minutos', 'minutos',
            (${dayBefore(thisMonth)}::date + 1) + time '12:00' at time zone 'UTC',
            ${extra.archived ? db`now()` : null})
    returning id`;
  return goal.id;
}

const routes = (goalId: string, phaseId: string, commitmentId: string) => ({
  task: `/metas/${goalId}/meses/${seg}/tarea/nueva`,
  newPhase: `/metas/${goalId}/fases/nueva`,
  editPhase: `/metas/${goalId}/fases/${phaseId}`,
  commitment: `/metas/${goalId}/compromisos/${commitmentId}`,
});

test("the four forms draw the goal's name, the phase's dates and the month's parent task", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: dropping a field from the loader call (the back link loses the name, the phase loses its dates).
  const stamp = Date.now();
  const name = `Meta carga ${stamp}`;
  const goalId = await seedGoal(db, person.id, name);
  const [phase] = await db<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${goalId}, ${`Fase ${stamp}`}, ${thisMonth}::date, ${thisMonth}::date + 20) returning id`;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${person.id}, ${goalId}, ${`Hábito ${stamp}`}, 'daily', 'tap') returning id`;
  const [parent] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goalId}, ${`Padre ${stamp}`}, ${thisMonth}::date) returning id`;
  const href = routes(goalId, phase.id, commitment.id);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const path of [href.task, href.newPhase, href.editPhase, href.commitment]) {
      await page.goto(path);
      await expect(page.locator("main").getByText(name).first(), path).toBeVisible();
    }

    await page.goto(href.editPhase);
    await expect(page.getByLabel(plan.phaseForm.aimLabel)).toHaveValue(`Fase ${stamp}`);

    await page.goto(href.commitment);
    await expect(page.locator("main").getByText(`Hábito ${stamp}`).first()).toBeVisible();

    // Kills: resolving `?padre=` from nothing.
    await page.goto(`${href.task}?padre=${parent.id}`);
    await expect(page.getByRole("heading", { name: "Una sub-tarea" })).toBeVisible();
    await expect(page.getByText(`PADRE ${stamp} · `, { exact: false }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an archived goal and an ended goal answer not-found on each form", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping the archived or the ended check from a page.
  const stamp = Date.now();
  const cases = [
    { label: "archived", id: await seedGoal(db, person.id, `Archivada ${stamp}`, { archived: true }) },
    { label: "ended", id: await seedGoal(db, person.id, `Terminada ${stamp}`, { horizon: thisMonth }) },
  ];
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    for (const { label, id } of cases) {
      const [phase] = await db<{ id: string }[]>`
        insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
        values (${person.id}, ${id}, 'Fase', ${dayBefore(thisMonth)}::date - 30, ${dayBefore(thisMonth)}::date - 10) returning id`;
      const href = routes(id, phase.id, "00000000-0000-0000-0000-000000000000");
      for (const path of [href.task, href.newPhase, href.editPhase]) {
        await page.goto(path);
        await expect(missing(page), `${label} ${path}`).toBeVisible();
      }
    }
  } finally {
    await context.close();
  }
});

test("the commitment page opens a bare one and one a fact names, and refuses a retired one and a foreign one", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: reading the commitment's retirement or fact count from nothing.
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta compromisos ${stamp}`);
  const otherGoal = await seedGoal(db, person.id, `Otra ${stamp}`);
  const make = async (goal: string, label: string, retired: boolean) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at, retired_at)
      values (${person.id}, ${goal}, ${`${label} ${stamp}`}, 'daily', 'tap', now() - interval '10 days',
              ${retired ? db`now()` : null}) returning id`;
    return row.id;
  };
  const bare = await make(goalId, "Libre", false);
  const retired = await make(goalId, "Retirado", true);
  const named = await make(goalId, "Con hecho", false);
  const foreign = await make(otherGoal, "De otra", false);
  await seedFact(db, person.id, named, goalId, dayBefore(todayInZone()));

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goalId}/compromisos/${bare}`);
    await expect(missing(page)).toHaveCount(0);
    await expect(page.locator("main").getByText(`Libre ${stamp}`).first()).toBeVisible();
    // A commitment a fact names opens too (RP-127): its name changes, its cadence reads as it was.
    await page.goto(`/metas/${goalId}/compromisos/${named}`);
    await expect(missing(page)).toHaveCount(0);
    await expect(page.locator("main").getByText(`Con hecho ${stamp}`).first()).toBeVisible();
    for (const id of [retired, foreign, "00000000-0000-0000-0000-000000000000"]) {
      await page.goto(`/metas/${goalId}/compromisos/${id}`);
      await expect(missing(page), id).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("the four pages read the form loader, not the whole goal", async () => {
  // Kills: keeping `loadGoal` on a page. The statements are counted at `scripts/plan/form-loader.ts`.
  const root = resolve(process.cwd(), "app/(app)/metas/[goalId]");
  for (const path of [
    "meses/[mes]/tarea/nueva/page.tsx",
    "fases/nueva/page.tsx",
    "fases/[phaseId]/page.tsx",
    "compromisos/[commitmentId]/page.tsx",
  ]) {
    const source = readFileSync(resolve(root, path), "utf8");
    expect(source, path).toMatch(/\bloadGoalForm\b/);
    expect(source, path).not.toMatch(/\bloadGoal\b/);
  }
});
