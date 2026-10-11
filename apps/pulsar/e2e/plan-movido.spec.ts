import { test, expect } from "./fixtures";
import roadmap from "../messages/es/roadmap.json";
import { planMoved } from "@/lib/plan/roadmap-read";
import type { PlanTask } from "@/lib/plan/roadmap";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `RoadmapHoyMovido.dc.html`, `RoadmapHoyMovidoDias.dc.html` (
// RP-52): a goal whose last month closed short draws the card; «Entendido»
// writes `plan_seen` and a reload keeps it gone; a goal whose month met its
// room draws none; the next task of the plan says this month's part.

function monthStartOf(offset: number): string {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
}

for (const width of [390, 1440]) {
  test(`Hoy at ${width} says the plan moved, dismisses it for good, and names the next task of the plan`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const closed = monthStartOf(-1);
    const shortName = `Meta corta ${stamp}`;
    const metName = `Meta cumplida ${stamp}`;
    const bigName = `Tarea grande ${stamp}`;

    const seedGoal = async (name: string) => {
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
        values (${person.id}, ${name}, '2099-12-31'::date, 'minutos', 'minutos', 600, '2020-01-01T00:00:00Z'::timestamptz)
        returning id
      `;
      return goal.id;
    };
    const seedTask = async (goal: string, name: string, estimate: number, created: string, doneOn: string | null) => {
      const [task] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, created_at)
        values (${person.id}, ${goal}, ${name}, ${estimate}, true, ${created}::timestamptz) returning id
      `;
      if (doneOn !== null) {
        await db`
          insert into goals.facts (user_id, goal_id, one_off_id, day)
          values (${person.id}, ${goal}, ${task.id}, ${doneOn}::date)
        `;
      }
    };

    // 5 h done of the closed month's 12 h: the end moves.
    const short = await seedGoal(shortName);
    await seedTask(short, `Hecha corta ${stamp}`, 300, "2020-01-01T00:00:00Z", closed);
    await seedTask(short, bigName, 1800, "2020-01-02T00:00:00Z", null);
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${short}, ${closed}::date, 720)
    `;
    // 10 h done of its 10 h: the end stays.
    const met = await seedGoal(metName);
    await seedTask(met, `Hecha cumplida ${stamp}`, 600, "2020-01-01T00:00:00Z", closed);
    await seedTask(met, `Resto ${stamp}`, 1800, "2020-01-02T00:00:00Z", null);

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const seen = (text: string | RegExp) => page.getByText(text).locator("visible=true");
      const title = seen(new RegExp(`^Tu plan de ${shortName} se movió \\d+ (día|días|semana|semanas)$`));

      await expect.soft(title, "a goal whose month closed short draws the card").toHaveCount(1);
      await expect.soft(seen(new RegExp(`^Tu plan de ${metName}`)), "a goal whose month met its room draws none").toHaveCount(0);
      await expect.soft(seen(/cerró con 5 h de 12 h\./)).toHaveCount(1);
      await expect.soft(seen("Siguiente del plan · 10 h este mes").first(), "the next task reads the part, labelled").toBeVisible();
      await expect.soft(page.getByRole("link", { name: "Ver el plan" }).locator("visible=true")).toHaveAttribute(
        "href",
        `/metas/${short}/plan`,
      );

      await page.getByRole("button", { name: "Entendido" }).locator("visible=true").click();
      await expect(title, "Entendido removes the card").toHaveCount(0);
      await page.reload();
      await expect(page.locator("main")).toHaveCount(1);
      await expect(seen(shortName).first()).toBeVisible();
      await expect(title, "a reload keeps it gone").toHaveCount(0);
      await expect(page.getByRole("button", { name: "Entendido" }).locator("visible=true")).toHaveCount(0);
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// A month that closed 60 min short moves the end a few days; 300 short moves it
// about half a month; none short moves it not at all. Each expected number is
// the one `planMoved` reads from the same seed, never typed.
for (const [width, kind] of [[390, "days"], [390, "weeks"], [1440, "days"], [1440, "weeks"]] as const) {
  test(`Hoy at ${width} says ${kind === "days" ? "days under a week" : "weeks from a week"}, and nothing for a move of none`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const today = todayInZone();
    const closed = monthStartOf(-1);
    const rhythm = 600;
    const bigEstimate = 1800;

    type Case = { name: string; done: number; id: string };
    const cases: Case[] = [
      kind === "days"
        ? { name: `Meta días ${stamp}`, done: 540, id: "" }
        : { name: `Meta semanas ${stamp}`, done: 300, id: "" },
      { name: `Meta quieta ${stamp}`, done: 600, id: "" },
    ];
    for (const item of cases) {
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
        values (${person.id}, ${item.name}, '2099-12-31'::date, 'minutos', 'minutos', ${rhythm}, '2020-01-01T00:00:00Z'::timestamptz)
        returning id
      `;
      item.id = goal.id;
      const [small] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position, created_at)
        values (${person.id}, ${goal.id}, ${`Hecha ${item.name}`}, ${item.done}, true, 1, '2020-01-01T00:00:00Z'::timestamptz)
        returning id
      `;
      await db`
        insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position, created_at)
        values (${person.id}, ${goal.id}, ${`Grande ${item.name}`}, ${bigEstimate}, true, 2, '2020-01-02T00:00:00Z'::timestamptz)
      `;
      await db`
        insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goal.id}, ${small.id}, ${closed}::date)
      `;
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${closed}::date, ${rhythm})
      `;
    }

    const expected = (done: number) => {
      const tasks: PlanTask[] = [
        { id: "a", parentId: null, name: "a", plannedMonth: null, day: null, estimate: done, doneOn: closed, note: null, inPlan: true, createdOn: "2020-01-01", position: 1 },
        { id: "b", parentId: null, name: "b", plannedMonth: null, day: null, estimate: bigEstimate, doneOn: null, note: null, inPlan: true, createdOn: "2020-01-02", position: 2 },
      ];
      return planMoved({
        rhythm,
        budgets: [{ month: closed, amount: rhythm }],
        tasks,
        openedOn: "2020-01-01",
        horizon: "2099-12-31",
        today,
        seen: null,
      });
    };
    const [moved, still] = cases.map((item) => expected(item.done));
    expect(moved, "the seed moves the plan").not.toBeNull();
    if (kind === "days") expect(moved!.movedDays, "the short seed moves under a week").toBeLessThan(7);
    else expect(moved!.movedDays, "the long seed moves a week or more").toBeGreaterThanOrEqual(7);
    expect(still, "the met seed does not move").toBeNull();

    const body = (notice: NonNullable<typeof moved>, done: number, tail: string) => {
      const closedName = MONTHS[Number(notice.closedMonth.slice(5, 7)) - 1];
      const nextName = MONTHS[Number(notice.closedMonth.slice(5, 7)) % 12];
      const end = civilDateToDate(notice.end);
      const hours = (minutes: number) => `${minutes / 60} h`;
      return (
        `${closedName[0].toUpperCase()}${closedName.slice(1)} cerró con ${hours(done)} de ${hours(rhythm)}. ` +
        `Lo que faltó pasó a ${nextName}${tail} Ahora terminas el ${end.getUTCDate()} de ${MONTHS[end.getUTCMonth()]} de ${end.getUTCFullYear()}.`
      );
    };
    const dayCount = moved!.movedDays;
    const weekCount = Math.max(1, Math.round(moved!.movedDays / 7));

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const seen = (text: string) => page.getByText(text, { exact: true }).locator("visible=true");

      if (kind === "days") {
        await expect
          .soft(
            seen(`Tu plan de ${cases[0].name} se movió ${dayCount} ${dayCount === 1 ? "día" : "días"}`),
            "under a week reads the days",
          )
          .toHaveCount(1);
        await expect
          .soft(seen(body(moved!, 540, ".")), "under a week drops the sentence about the rest")
          .toHaveCount(1);
      } else {
        await expect
          .soft(
            seen(`Tu plan de ${cases[0].name} se movió ${weekCount} ${weekCount === 1 ? "semana" : "semanas"}`),
            "a week or more reads whole weeks",
          )
          .toHaveCount(1);
        await expect
          .soft(
            seen(body(moved!, 300, " y el resto se corrió detrás.")),
            "a week or more says the rest ran behind",
          )
          .toHaveCount(1);
      }
      await expect
        .soft(page.getByText(new RegExp(`^Tu plan de ${cases[1].name}`)).locator("visible=true"), "a move of none draws no card")
        .toHaveCount(0);
      await expect.soft(page.getByText(cases[1].name, { exact: true }).locator("visible=true").first()).toBeVisible();
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

// `RoadmapHoyMovidoVarios.dc.html` (RP-52): two moved plans and a
// met one draw one card with a line per moved goal and one «Entendido» that
// writes `plan_seen` for both.
for (const width of [360, 390, 1440]) {
  test(`Hoy at ${width} draws one card for two moved plans, dismisses both at once and lists the met one never`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const today = todayInZone();
    const closed = monthStartOf(-1);
    const rhythm = 600;
    const bigEstimate = 1800;

    const cases = [
      { name: `Meta días ${stamp}`, done: 540, id: "" },
      { name: `Meta semanas ${stamp}`, done: 300, id: "" },
      { name: `Meta quieta ${stamp}`, done: 600, id: "" },
    ];
    for (const item of cases) {
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
        values (${person.id}, ${item.name}, '2099-12-31'::date, 'minutos', 'minutos', ${rhythm}, '2020-01-01T00:00:00Z'::timestamptz)
        returning id
      `;
      item.id = goal.id;
      const [small] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position, created_at)
        values (${person.id}, ${goal.id}, ${`Hecha ${item.name}`}, ${item.done}, true, 1, '2020-01-01T00:00:00Z'::timestamptz)
        returning id
      `;
      await db`
        insert into goals.one_offs (user_id, goal_id, name, estimate, in_plan, position, created_at)
        values (${person.id}, ${goal.id}, ${`Grande ${item.name}`}, ${bigEstimate}, true, 2, '2020-01-02T00:00:00Z'::timestamptz)
      `;
      await db`
        insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goal.id}, ${small.id}, ${closed}::date)
      `;
      await db`
        insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${closed}::date, ${rhythm})
      `;
    }

    const expected = (done: number) => {
      const tasks: PlanTask[] = [
        { id: "a", parentId: null, name: "a", plannedMonth: null, day: null, estimate: done, doneOn: closed, note: null, inPlan: true, createdOn: "2020-01-01", position: 1 },
        { id: "b", parentId: null, name: "b", plannedMonth: null, day: null, estimate: bigEstimate, doneOn: null, note: null, inPlan: true, createdOn: "2020-01-02", position: 2 },
      ];
      return planMoved({
        rhythm,
        budgets: [{ month: closed, amount: rhythm }],
        tasks,
        openedOn: "2020-01-01",
        horizon: "2099-12-31",
        today,
        seen: null,
      });
    };
    const [days, weeks, still] = cases.map((item) => expected(item.done));
    expect(days!.movedDays, "the short seed moves under a week").toBeLessThan(7);
    expect(weeks!.movedDays, "the long seed moves a week or more").toBeGreaterThanOrEqual(7);
    expect(still, "the met seed does not move").toBeNull();
    const dayCount = days!.movedDays;
    const weekCount = Math.max(1, Math.round(weeks!.movedDays / 7));
    const endOf = (notice: NonNullable<typeof days>) => {
      const end = civilDateToDate(notice.end);
      return `${end.getUTCDate()} de ${MONTHS[end.getUTCMonth()]} de ${end.getUTCFullYear()}`;
    };

    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const seen = (text: string | RegExp) => page.getByText(text).locator("visible=true");
      const card = seen("Dos planes se movieron");

      await expect.soft(card, "two moved plans draw one card titled with the count").toHaveCount(1);
      await expect.soft(seen(/^Tu plan de .* se movió/), "no per-goal card stands beside it").toHaveCount(0);
      const closedName = MONTHS[Number(closed.slice(5, 7)) - 1];
      const nextName = MONTHS[Number(closed.slice(5, 7)) % 12];
      await expect
        .soft(
          page
            .getByText(
              `${closedName[0].toUpperCase()}${closedName.slice(1)} cerró con menos de lo planeado. Lo que faltó pasó a ${nextName} y el resto se corrió detrás.`,
              { exact: true },
            )
            .locator("visible=true"),
          "the sentence opens with the closed month capitalised",
        )
        .toHaveCount(1);
      await expect
        .soft(
          seen(`Se movió ${dayCount} ${dayCount === 1 ? "día" : "días"}. Ahora terminas el ${endOf(days!)}.`),
          "the short goal reads its days",
        )
        .toHaveCount(1);
      await expect
        .soft(
          seen(`Se movió ${weekCount} ${weekCount === 1 ? "semana" : "semanas"}. Ahora terminas el ${endOf(weeks!)}.`),
          "the long goal reads its weeks",
        )
        .toHaveCount(1);
      await expect.soft(seen(cases[2].name).first(), "the met goal stays a goal on Hoy").toBeVisible();
      const links = page.getByRole("link", { name: roadmap.hoyMovido.seePlan }).locator("visible=true");
      await expect.soft(links).toHaveCount(2);
      // «Ver el plan» is a short label: a narrow phone squeezes the sentence beside it, never the link.
      for (const link of await links.all()) {
        const rows = await link.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        });
        expect.soft(rows, "«Ver el plan» sits on one line").toBe(1);
      }
      await expect.soft(page.getByRole("button", { name: roadmap.hoyMovido.dismiss }).locator("visible=true")).toHaveCount(1);

      await page.getByRole("button", { name: roadmap.hoyMovido.dismiss }).locator("visible=true").click();
      await expect(card, "Entendido removes the card").toHaveCount(0);
      await page.reload();
      await expect(page.locator("main")).toHaveCount(1);
      await expect(seen(cases[0].name).first()).toBeVisible();
      await expect(card, "a reload keeps it gone").toHaveCount(0);
      await expect(page.getByRole("button", { name: roadmap.hoyMovido.dismiss }).locator("visible=true")).toHaveCount(0);

      const rows = await db<{ id: string; seen: string | null }[]>`
        select id, plan_seen::text as seen from goals.goals where user_id = ${person.id}
      `;
      for (const item of cases.slice(0, 2)) {
        expect(rows.find((row) => row.id === item.id)?.seen, "both goals' plan_seen is the closed month").toBe(closed);
      }
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}
