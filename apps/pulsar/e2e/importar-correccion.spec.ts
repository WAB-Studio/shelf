import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import type { RawDraft } from "../lib/import/draft";
import { test, expect } from "./fixtures";
import {
  SMALL,
  TASK_A,
  asPerson,
  countOf,
  createButton,
  months,
  plus,
  planText,
  toReview,
  toSeededReview,
  word,
  type Seed,
} from "./importar-plan";

// The corrections the check and the normaliser propose, drawn under their part (RP-90, RP-97). The
// boards are `ImportarCorreccion` and `ImportarFuera`. An untouched correction counts as accepted:
// the tree already shows what it proposes. «Aceptar» confirms, «Dejar como estaba» undoes.

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const amountButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${name}`, "i") });

const LONG = Array(19).fill("revisar").join(" ");
const SHORT = Array(15).fill("revisar").join(" ");

function seededPlan(): Seed {
  const { first } = months();
  const lines = [
    "Ordenar la casa", //                          1 goal
    "Oct 6, 2026 · @ActuallyPanda56", //            2 placed nowhere
    `${LONG} 3 h`, //                               3 task, 151 characters of name
    "Practicar inglés, semana 3", //                4 task
    "Octubre 5 h", //                               5 month
    "[embedded content: roadmap · 4 fases]", //     6 placed nowhere
  ];
  const range = (n: number) => [{ from: n, to: n }];
  const raw: RawDraft = {
    goals: [
      {
        key: "casa",
        parent: null,
        name: SMALL,
        horizon: plus(300),
        measure: { name: "horas", unit: "horas" },
        rate: null,
        noteSrc: [],
        noteText: null,
        src: range(1),
        phases: [],
        months: [{ month: first, amount: 5, src: range(5) }],
        commitments: [],
        rules: [{ id: "ing", label: "inglés", perWeek: 3 }],
        tasks: [
          { name: LONG, month: first, estimate: 3, week: "Semana 1", rule: "ing", noteSrc: [], noteText: null, src: range(3), children: [] },
          { name: "Practicar inglés", month: first, estimate: 1, week: "Semana 3", rule: null, noteSrc: [], noteText: null, src: range(4), children: [] },
        ],
      },
    ],
  };
  return { raw, source: { kind: "lines", lines } };
}

test.describe("a correction hangs under its part and is accepted unless the person undoes it (RP-90)", () => {
  test("monthSumDiffers: «decía», «se propone», «porque» under the month, the row shows the proposal; undoing it restores the plan's figure", async ({ person, browser, baseURL }) => {
    // Kills: drawing the plan's figure with the proposal beside it, or an undo that keeps the proposal.
    const { first } = months();
    const month = word(first);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await expect(amountButton(page, month)).toHaveText("9 h");
      await expect(page.getByText(messages.review.correction.said, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.review.correction.proposed, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.review.correction.why, { exact: true })).toBeVisible();
      await expect(page.getByText(`${cap(month)}: 10 h`, { exact: true })).toBeVisible();
      await expect(page.getByText(`${cap(month)}: 9 h`, { exact: true })).toBeVisible();
      await expect(page.getByText(new RegExp(`^Las tareas de ${month} suman 9 h`))).toBeVisible();
      await expect(page.getByRole("button", { name: messages.review.correction.accept, exact: true })).toBeVisible();

      await page.getByRole("button", { name: messages.review.correction.decline }).click();
      await expect(page.getByText("Se queda como decía el plan: 10 h.", { exact: true })).toBeVisible();
      await expect(amountButton(page, month)).toHaveText("10 h");
      await expect(page.getByText(messages.review.correction.proposed, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: messages.review.correction.acceptDeclined }).click();
      await expect(amountButton(page, month)).toHaveText("9 h");
      await expect(page.getByText("Se queda como decía el plan: 10 h.", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: messages.review.correction.accept, exact: true }).click();
      await expect(amountButton(page, month)).toHaveText("9 h");
      await expect(page.getByText("Se queda como decía el plan: 10 h.", { exact: true })).toHaveCount(0);
    });
  });

  test("an untouched correction is written as proposed: the month is the sum of its tasks", async ({ person, browser, baseURL, db }) => {
    // Kills: writing what the plan said while the screen showed the proposal.
    const { first } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [row] = await db`
        select b.amount from goals.month_budgets b join goals.goals g on g.id = b.goal_id
        where b.user_id = ${person.id} and g.name = ${SMALL} and b.month = ${`${first}-01`}`;
      expect(row.amount).toBe(540);
    });
  });

  test("declining monthSumDiffers writes the plan's own figure, read from the database", async ({ person, browser, baseURL, db }) => {
    // Kills: writing the sum after the person said «Dejar como estaba» (ignoring `declined`).
    const { first } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await page.getByRole("button", { name: messages.review.correction.decline }).click();
      await expect(amountButton(page, word(first))).toHaveText("10 h");
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [row] = await db`
        select b.amount from goals.month_budgets b join goals.goals g on g.id = b.goal_id
        where b.user_id = ${person.id} and g.name = ${SMALL} and b.month = ${`${first}-01`}`;
      expect(row.amount).toBe(600);
    });
  });

  test("what the person undid and left out is still so after a reload, and nothing was written", async ({ person, browser, baseURL, db }) => {
    // Kills: not saving the review (`saveReview`) when a correction or a mark changes.
    const { first } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await page.getByRole("button", { name: messages.review.correction.decline }).click();
      await page.getByRole("checkbox", { name: new RegExp(`^${TASK_A}`) }).uncheck();
      await page.reload();
      await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
      await expect(page.getByText("Se queda como decía el plan: 10 h.", { exact: true })).toBeVisible();
      await expect(amountButton(page, word(first))).toHaveText("10 h");
      await expect(page.getByRole("checkbox", { name: new RegExp(`^${TASK_A}`) })).not.toBeChecked();
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
    });
  });
});

test.describe("a name cut to 120, a week rule broken, a line with no place (RP-90, RP-96, RP-97)", () => {
  test("nameShortened shows the short name in the tree and the whole one as «decía»; undoing it sends the task out, with its line", async ({ person, browser, baseURL }) => {
    // Kills: accepting without looking at `declined`: the long name would still be created.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seededPlan());
      await expect(page.getByRole("checkbox", { name: new RegExp(`^${SHORT}`) })).toBeVisible();
      await expect(page.getByText(LONG, { exact: true })).toBeVisible();
      await expect(page.getByText(SHORT, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(messages.review.correction.nameShortened.why, { exact: true })).toBeVisible();
      const before = await countOf(page);

      // The name correction's own block: the one whose «decía» holds the long name.
      const block = page.locator("div").filter({ has: page.getByText(LONG, { exact: true }) }).filter({ has: page.getByRole("button", { name: messages.review.correction.decline }) }).last();
      await block.getByRole("button", { name: messages.review.correction.decline }).click();
      await expect(page.getByText("Se queda fuera: con 120 caracteres o menos no cabía.", { exact: true })).toBeVisible();
      await expect.poll(async () => (await countOf(page)).out).toBe(before.out + 1);
      const blocked = page.getByText(messages.review.blocked.title, { exact: true }).locator("xpath=..");
      await expect(blocked).toContainText(LONG);
      await expect(blocked).toContainText("línea 3");
    });
  });

  test("the week rule broken is a notice in the box's own words, with no button", async ({ person, browser, baseURL }) => {
    // Kills: drawing «Aceptar» and «Dejar como estaba» on a notice.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seededPlan());
      await expect(
        page.getByText("Semana 3 no tiene tareas de inglés. Tu plan pide 3 h de inglés cada semana.", { exact: true }),
      ).toBeVisible();
      // Two corrections (the name, the month's sum); the notice adds none.
      await expect(page.getByRole("button", { name: messages.review.correction.accept, exact: true })).toHaveCount(2);
      await expect(page.getByRole("button", { name: messages.review.correction.decline, exact: true })).toHaveCount(2);
    });
  });

  test("lines no part carries are listed with their text, their number and why, and counted as «fuera»", async ({ person, browser, baseURL }) => {
    // Kills: leaving `notPlaced` lines out of the list or of the count.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seededPlan());
      const count = await countOf(page);
      expect(count).toMatchObject({ total: 6, out: 2 });
      expect(count.plan + count.notes + count.out).toBe(6);
      await expect(page.getByText(messages.review.unplaced.hint, { exact: true })).toBeVisible();
      const section = page.getByText(messages.review.unplaced.title, { exact: true }).locator("xpath=..");
      await expect(section).toContainText("Oct 6, 2026 · @ActuallyPanda56");
      await expect(section).toContainText("línea 2");
      await expect(section).toContainText("[embedded content: roadmap · 4 fases]");
      await expect(section).toContainText("línea 6");
      await expect(section.getByText(messages.review.out.notPlaced)).toHaveCount(2);
    });
  });

  test("a plan read from a PDF counts its parts and says it was read from one", async ({ person, browser, baseURL }) => {
    // Kills: counting a source with no lines as lines, or hiding where it came from.
    const range = (n: number) => [{ from: n, to: n }];
    const { first } = months();
    const raw: RawDraft = {
      goals: [
        {
          key: "casa",
          parent: null,
          name: SMALL,
          horizon: plus(300),
          measure: { name: "horas", unit: "horas" },
          rate: null,
          noteSrc: range(2),
          noteText: "Las reglas del plan",
          src: range(1),
          phases: [],
          months: [],
          commitments: [],
          rules: [],
          tasks: [
            { name: "Primera", month: first, estimate: 1, week: null, rule: null, noteSrc: [], noteText: null, src: range(3), children: [] },
            { name: "Segunda", month: first, estimate: 1, week: null, rule: null, noteSrc: [], noteText: null, src: range(4), children: [] },
          ],
        },
      ],
    };
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, { raw, source: { kind: "parts", lines: null }, sourceName: "plan.pdf" });
      await expect(page.getByText(/leído de un PDF/i).first()).toBeVisible();
      const count = await countOf(page, "partes");
      expect(count).toMatchObject({ total: 4, plan: 3, notes: 1, out: 0 });
    });
  });
});
