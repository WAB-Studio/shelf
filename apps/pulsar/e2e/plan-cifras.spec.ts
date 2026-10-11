import roadmap from "../messages/es/roadmap.json";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// `RoadmapMesCifras.dc.html` (RP-50): the current month's figure
// is what is done in it, by the plan's own rule, never the measure's reached
// total; a later month says what the plan fills. Calendar-bound.

const NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const today = todayInZone();
const thisYear = today.slice(0, 4);
const m0 = monthOf(today);
const m1 = nextMonth(m0);
const name = (month: string) =>
  month.slice(0, 4) === thisYear ? NAMES[Number(month.slice(5, 7)) - 1] : `${NAMES[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`;

const say = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template.replace(/<\/?fig>/g, ""));

const section = (page: import("@playwright/test").Page, label: string) =>
  page.locator("section").filter({ has: page.getByText(label, { exact: true }) });

for (const width of [390, 1440]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the current month counts the tasks done, not the hours nor the measure's reached; the next reads the hours planned", async ({ page, db, personId }) => {
      // Opened on the 1st, Bogotá's midnight: this month plans its whole rhythm (RP-74) whatever the run date.
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
        values (${personId}, ${`Meta cifras ${Date.now()}`}, ${`${Number(thisYear) + 1}-${today.slice(5, 7)}-01`}::date, 'minutos', 'minutos', 720, date_trunc('month', now() at time zone 'America/Bogota') at time zone 'America/Bogota')
        returning id
      `;
      const goalId = goal.id;
      try {
        // Two done leaves (3 h, 2 h), one undone 4 h task, one big undone task to fill the next month.
        let position = 0;
        for (const [taskName, estimate, done] of [["Hecha 3", 180, true], ["Hecha 2", 120, true], ["Pendiente", 240, false], ["Grande", 2400, false]] as const) {
          position += 1;
          const [task] = await db<{ id: string }[]>`
            insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
            values (${personId}, ${goalId}, ${taskName}, ${estimate}, ${position}, true) returning id
          `;
          if (done) {
            await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${personId}, ${goalId}, ${task.id}, ${today}::date)`;
          }
        }
        // A declared fact of 7 h: the measure reads 12 h reached, the plan's done reads 5 h.
        const [commitment] = await db<{ id: string }[]>`
          insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
          values (${personId}, ${goalId}, ${`Sesión ${Date.now()}`}, 'daily', 'quantity', 30, 'minutos', now() - interval '40 days')
          returning id
        `;
        await db`insert into goals.facts (user_id, goal_id, commitment_id, day, quantity) values (${personId}, ${goalId}, ${commitment.id}, ${today}::date, 420)`;

        await page.goto(`/metas/${goalId}/plan`);
        const current = section(page, say(roadmap.plan.currentMonth, { month: name(m0) }));
        await expect(current.getByText("2 de 4 tareas hechas", { exact: true })).toBeVisible();
        // The reached total (12 h) is never the done figure, in the new words or the old.
        await expect(page.getByText(/^12 de \d+ tareas? hechas?$/)).toHaveCount(0);
        await expect(page.getByText(/en tareas hechas/)).toHaveCount(0);
        await expect(page.getByText(/12 h hechas/)).toHaveCount(0);
        // Figures in DM Mono, the words between them in Archivo.
        const line = current.getByText("2 de 4 tareas hechas", { exact: true });
        const family = (locator: import("@playwright/test").Locator) => locator.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(await family(line)).not.toMatch(/mono/i);
        const figures = line.locator("> span");
        await expect(figures).toHaveCount(2);
        for (let i = 0; i < 2; i++) expect(await family(figures.nth(i))).toMatch(/mono/i);
        const width = await current.locator("span[aria-hidden] > span").first().evaluate((el) => (el as HTMLElement).style.inlineSize);
        expect(width).toBe("41%");
        const next = section(page, name(m1));
        const planned = next.getByText(say(roadmap.plan.monthPlanned, { filled: "12 h", amount: "12 h" }), { exact: true });
        await expect(planned).toBeVisible();
        await expect(planned.locator("> span")).toHaveCount(2);
      } finally {
        await db`delete from goals.facts where goal_id = ${goalId} and user_id = ${personId}`;
        await db`delete from goals.commitments where goal_id = ${goalId} and user_id = ${personId}`;
        await db`delete from goals.month_budgets where goal_id = ${goalId} and user_id = ${personId}`;
        await db`delete from goals.one_offs where goal_id = ${goalId} and user_id = ${personId}`;
        await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
      }
    });
  });
}
