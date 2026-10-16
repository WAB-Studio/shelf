import type { Browser, BrowserContext, Page } from "@playwright/test";
import type postgres from "postgres";

import { weeksToPhaseSpan } from "@/components/goal/phase-weeks";
import { civilDateInZone, civilDateLabel, dateToCivilDate } from "@/lib/zone";

import { test, expect, visit, type Person } from "./fixtures";
import goalMessages from "../messages/es/goal.json";
import plan from "../messages/es/plan.json";

// RP-127: a phase opens its own form on `/metas/<goal>/fases/<phase>`, changes
// its aim and weeks, and goes after a sheet. The row on the goal's screen is
// not yet a link (module 1016 owns it), so each test opens the route by URL.

const WIDTHS: [number, number][] = [
  [360, 740],
  [1280, 800],
];

const SAVE = goalMessages.phases.save;
const DELETE = goalMessages.phases.delete;
const CONFIRM_DELETE = goalMessages.phases.deleteConfirm;
const KEEP = goalMessages.phases.keep;

type Seeded = {
  goalId: string;
  openedOn: string;
  firstId: string;
  firstAim: string;
  secondId: string;
  secondAim: string;
};

// A goal with no end and two phases: weeks 1–2 and weeks 4–5. The prefill the
// new-phase form would offer after them is weeks 6–9, so a form that opens on
// anything but 4–5 for the second is not reading the phase it was opened on.
async function seed(
  db: postgres.Sql,
  personId: string,
  options: { archived?: boolean; endedYesterday?: boolean } = {},
): Promise<Seeded> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const archivedAt = options.archived ? new Date() : null;
  const horizon = options.endedYesterday ? dateToCivilDate(new Date(Date.now() - 36 * 3600_000)) : null;
  const [goal] = await db<{ id: string; created_at: Date }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at)
    values (${personId}, ${`Meta cambiar fase ${stamp}`}, ${horizon}::date, ${archivedAt})
    returning id, created_at
  `;
  const openedOn = civilDateInZone(goal.created_at);
  const firstAim = `Cimientos ${stamp}`;
  const secondAim = `Marcha ${stamp}`;
  const first = weeksToPhaseSpan(openedOn, 1, 2, null);
  const second = weeksToPhaseSpan(openedOn, 4, 5, null);
  const [a] = await db<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${personId}, ${goal.id}, ${firstAim}, ${first.startsOn}::date, ${first.endsOn}::date) returning id
  `;
  const [b] = await db<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${personId}, ${goal.id}, ${secondAim}, ${second.startsOn}::date, ${second.endsOn}::date) returning id
  `;
  return { goalId: goal.id, openedOn, firstId: a.id, firstAim, secondId: b.id, secondAim };
}

type PhaseRow = { aim: string; starts_on: string; ends_on: string };

async function phaseRow(db: postgres.Sql, id: string): Promise<PhaseRow | undefined> {
  const [row] = await db<PhaseRow[]>`
    select aim, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on
    from goals.phases where id = ${id}
  `;
  return row;
}

async function phaseCount(db: postgres.Sql, goalId: string): Promise<number> {
  const [row] = await db<{ count: string }[]>`select count(*)::text as count from goals.phases where goal_id = ${goalId}`;
  return Number(row.count);
}

async function openContext(browser: Browser, person: Person, baseURL: string, width: number, height: number) {
  return browser.newContext({ storageState: person.sessionFile, baseURL, viewport: { width, height } });
}

// Server action calls only: the route's own GETs and prefetches are not requests the form sent.
function countActionPosts(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) calls.push(request.url());
  });
  return calls;
}

async function holdActions(page: Page, ms: number): Promise<void> {
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}

async function openEdit(context: BrowserContext, goalId: string, phaseId: string): Promise<Page> {
  const page = await context.newPage();
  await visit(page, `/metas/${goalId}/fases/${phaseId}`);
  await expect(page.getByRole("heading", { level: 1, name: goalMessages.phases.editTitle })).toBeVisible();
  return page;
}

for (const [width, height] of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test("a phase opens prefilled with its own aim and weeks, not the next free span", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        await expect(page.getByLabel(plan.phaseForm.aimLabel)).toHaveValue(s.secondAim);
        await expect(page.getByLabel(plan.phaseForm.fromLabel)).toHaveValue("4");
        await expect(page.getByLabel(plan.phaseForm.toLabel)).toHaveValue("5");
        // Its own span is not a clash with itself, and the title is the edit's, not the new phase's.
        await expect(page.locator("#phase-weeks-hint")).not.toContainText("ya son de");
        await expect(page.getByRole("button", { name: SAVE, exact: true })).toBeEnabled();
        await expect(page.getByRole("button", { name: DELETE })).toBeVisible();

        const first = await openEdit(context, s.goalId, s.firstId);
        await expect(first.getByLabel(plan.phaseForm.aimLabel)).toHaveValue(s.firstAim);
        await expect(first.getByLabel(plan.phaseForm.fromLabel)).toHaveValue("1");
        await expect(first.getByLabel(plan.phaseForm.toLabel)).toHaveValue("2");
      } finally {
        await context.close();
      }
    });

    test("saving a new aim and span rewrites that row, adds none, and returns to the goal showing them", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        const newAim = `Marcha nueva ${Date.now()}`;
        await page.getByLabel(plan.phaseForm.aimLabel).fill(newAim);
        await page.getByLabel(plan.phaseForm.fromLabel).fill("3");
        await page.getByLabel(plan.phaseForm.toLabel).fill("4");
        await page.getByRole("button", { name: SAVE, exact: true }).click();
        await page.waitForURL(new RegExp(`/metas/${s.goalId}$`));

        const span = weeksToPhaseSpan(s.openedOn, 3, 4, null);
        expect(await phaseRow(db, s.secondId)).toEqual({ aim: newAim, starts_on: span.startsOn, ends_on: span.endsOn });
        expect(await phaseCount(db, s.goalId)).toBe(2);
        // The other phase is untouched.
        expect((await phaseRow(db, s.firstId))?.aim).toBe(s.firstAim);

        await expect(page.getByText(newAim)).toBeVisible();
        await expect(page.getByText("semanas 3–4")).toBeVisible();
        await expect(page.getByText(s.secondAim)).toHaveCount(0);
        await expect(page.getByText("semanas 4–5")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    test("saving the phase's own span unchanged is not an overlap with itself", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        const newAim = `Mismo tramo ${Date.now()}`;
        await page.getByLabel(plan.phaseForm.aimLabel).fill(newAim);
        // Touch the weeks and put them back: the typed span is its own, week for week.
        await page.getByLabel(plan.phaseForm.fromLabel).fill("5");
        await page.getByLabel(plan.phaseForm.fromLabel).fill("4");
        await expect(page.locator("#phase-weeks-hint")).not.toContainText("ya son de");
        await expect(page.getByLabel(plan.phaseForm.fromLabel)).not.toHaveAttribute("aria-invalid", "true");
        await page.getByRole("button", { name: SAVE, exact: true }).click();
        await page.waitForURL(new RegExp(`/metas/${s.goalId}$`));

        const span = weeksToPhaseSpan(s.openedOn, 4, 5, null);
        expect(await phaseRow(db, s.secondId)).toEqual({ aim: newAim, starts_on: span.startsOn, ends_on: span.endsOn });
      } finally {
        await context.close();
      }
    });

    test("while the save is in flight both buttons are disabled and a second tap sends no second request", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        const posts = countActionPosts(page);
        await holdActions(page, 1500);
        await page.getByLabel(plan.phaseForm.aimLabel).fill(`En vuelo ${Date.now()}`);
        const save = page.getByRole("button", { name: SAVE, exact: true });
        const remove = page.getByRole("button", { name: DELETE });
        await save.click();
        await expect(save).toBeDisabled();
        await expect(remove).toBeDisabled();
        await save.click({ force: true });
        await remove.click({ force: true });

        await page.waitForURL(new RegExp(`/metas/${s.goalId}$`));
        expect(posts).toHaveLength(1);
        expect(await phaseCount(db, s.goalId)).toBe(2);
      } finally {
        await context.close();
      }
    });

    test("weeks that overlap another phase are refused under the field and no request leaves", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        const posts = countActionPosts(page);
        await page.getByLabel(plan.phaseForm.fromLabel).fill("2");
        await page.getByLabel(plan.phaseForm.toLabel).fill("3");

        const hint = page.locator("#phase-weeks-hint");
        await expect(hint).toContainText(`Las semanas 1 a 2 ya son de «${s.firstAim}». Empieza en la 3.`);
        await expect(page.getByLabel(plan.phaseForm.fromLabel)).toHaveAttribute("aria-invalid", "true");
        await page.getByRole("button", { name: SAVE, exact: true }).click();

        await expect(hint).toBeVisible();
        expect(page.url()).toContain(`/metas/${s.goalId}/fases/${s.secondId}`);
        expect(posts).toHaveLength(0);
        expect(await phaseCount(db, s.goalId)).toBe(2);
        const span = weeksToPhaseSpan(s.openedOn, 4, 5, null);
        expect(await phaseRow(db, s.secondId)).toEqual({ aim: s.secondAim, starts_on: span.startsOn, ends_on: span.endsOn });
      } finally {
        await context.close();
      }
    });

    test("an overlap made elsewhere after the form opened is refused by the server and shown, the row unchanged", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        // Elsewhere, the first phase moves onto week 3: this form still knows it at weeks 1–2.
        const moved = weeksToPhaseSpan(s.openedOn, 3, 3, null);
        await db`update goals.phases set starts_on = ${moved.startsOn}::date, ends_on = ${moved.endsOn}::date where id = ${s.firstId}`;

        await page.getByLabel(plan.phaseForm.aimLabel).fill(`No se guarda ${Date.now()}`);
        await page.getByLabel(plan.phaseForm.fromLabel).fill("3");
        await page.getByLabel(plan.phaseForm.toLabel).fill("3");
        await expect(page.locator("#phase-weeks-hint")).not.toContainText("ya son de");
        await page.getByRole("button", { name: SAVE, exact: true }).click();

        await expect(page.getByText(plan.errors.phaseOverlap)).toBeVisible();
        expect(page.url()).toContain(`/metas/${s.goalId}/fases/${s.secondId}`);
        const span = weeksToPhaseSpan(s.openedOn, 4, 5, null);
        expect(await phaseRow(db, s.secondId)).toEqual({ aim: s.secondAim, starts_on: span.startsOn, ends_on: span.endsOn });
        // The form answers again after a refusal.
        await expect(page.getByRole("button", { name: SAVE, exact: true })).toBeEnabled();
      } finally {
        await context.close();
      }
    });

    test("two phases that meet mid-week share that week: either saves a rename with its dates unmoved", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      // The first ends on Monday of week 3, the second starts the Tuesday after: both are week 3.
      const monday = weeksToPhaseSpan(s.openedOn, 3, 3, null).startsOn;
      const sunday = weeksToPhaseSpan(s.openedOn, 5, 5, null).endsOn;
      await db`update goals.phases set ends_on = ${monday}::date where id = ${s.firstId}`;
      await db`update goals.phases set starts_on = ${monday}::date + 1, ends_on = ${sunday}::date where id = ${s.secondId}`;
      const secondFrom = await db<{ d: string }[]>`select to_char(${monday}::date + 1, 'YYYY-MM-DD') as d`;
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        await expect(page.getByLabel(plan.phaseForm.fromLabel)).toHaveValue("3");
        await expect(page.locator("#phase-weeks-hint")).not.toContainText("ya son de");
        await expect(page.locator("#phase-weeks-hint")).toContainText(`Del ${civilDateLabel(secondFrom[0].d, true)} al `);
        const renamed = `Sigue ${Date.now()}`;
        await page.getByLabel(plan.phaseForm.aimLabel).fill(renamed);
        await page.getByRole("button", { name: SAVE, exact: true }).click();
        await page.waitForURL(new RegExp(`/metas/${s.goalId}$`));
        expect(await phaseRow(db, s.secondId)).toEqual({ aim: renamed, starts_on: secondFrom[0].d, ends_on: sunday });

        const first = await openEdit(context, s.goalId, s.firstId);
        await expect(first.locator("#phase-weeks-hint")).not.toContainText("ya son de");
        await first.getByLabel(plan.phaseForm.aimLabel).fill(`Antes ${Date.now()}`);
        await first.getByRole("button", { name: SAVE, exact: true }).click();
        await first.waitForURL(new RegExp(`/metas/${s.goalId}$`));
        expect((await phaseRow(db, s.firstId))?.ends_on).toBe(monday);
      } finally {
        await context.close();
      }
    });

    test("«Borrar la fase» opens a sheet, and «Dejarla como está» closes it with the phase still there and no delete sent", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        const posts = countActionPosts(page);
        await page.getByRole("button", { name: DELETE }).click();

        const sheet = page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText(goalMessages.phases.deleteBody)).toBeVisible();
        // Opening the sheet deletes nothing.
        expect(await phaseRow(db, s.secondId)).toBeDefined();
        expect(posts).toHaveLength(0);

        await sheet.getByRole("button", { name: KEEP }).click();
        await expect(sheet).toBeHidden();
        expect(page.url()).toContain(`/metas/${s.goalId}/fases/${s.secondId}`);
        expect(posts).toHaveLength(0);
        expect(await phaseRow(db, s.secondId)).toBeDefined();
        expect(await phaseCount(db, s.goalId)).toBe(2);

        await visit(page, `/metas/${s.goalId}`);
        await expect(page.getByText(s.secondAim)).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test("«Borrarla» deletes the phase, returns to the goal, and the list no longer shows it", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const s = await seed(db, person.id);
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        const page = await openEdit(context, s.goalId, s.secondId);
        await page.getByRole("button", { name: DELETE }).click();
        await page.getByRole("dialog").getByRole("button", { name: CONFIRM_DELETE }).click();
        await page.waitForURL(new RegExp(`/metas/${s.goalId}$`));

        await expect(page.getByText(s.firstAim)).toBeVisible();
        await expect(page.getByText(s.secondAim)).toHaveCount(0);
        await expect(page.getByText("semanas 4–5")).toHaveCount(0);
        expect(await phaseRow(db, s.secondId)).toBeUndefined();
        expect(await phaseCount(db, s.goalId)).toBe(1);
        expect(await phaseRow(db, s.firstId)).toBeDefined();
      } finally {
        await context.close();
      }
    });

    test("a phase that is not in the goal, or a goal that is archived or ended, draws the not-found page and no form", async ({
      person,
      browser,
      baseURL,
      db,
    }) => {
      const open = await seed(db, person.id);
      const other = await seed(db, person.id);
      const archived = await seed(db, person.id, { archived: true });
      const ended = await seed(db, person.id, { endedYesterday: true });
      const context = await openContext(browser, person, baseURL!, width, height);
      try {
        // Control: the same route opens for a phase of an open goal.
        await openEdit(context, open.goalId, open.secondId);

        const absent = [
          `/metas/${open.goalId}/fases/00000000-0000-4000-8000-000000000000`,
          `/metas/${open.goalId}/fases/no-es-un-uuid`,
          // A real phase, under another goal.
          `/metas/${open.goalId}/fases/${other.secondId}`,
          `/metas/${archived.goalId}/fases/${archived.secondId}`,
          `/metas/${ended.goalId}/fases/${ended.secondId}`,
        ];
        for (const path of absent) {
          const page = await context.newPage();
          await visit(page, path);
          await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
          await expect(page.getByRole("heading", { name: goalMessages.phases.editTitle })).toHaveCount(0);
          await expect(page.getByRole("button", { name: DELETE })).toHaveCount(0);
          await page.close();
        }
      } finally {
        await context.close();
      }
    });
  });
}
