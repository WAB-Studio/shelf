import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import goalMessages from "../messages/es/goal.json";
import plan from "../messages/es/plan.json";
import { horizonForWeeks, horizonWeeksOf } from "../lib/day/weeks";
import { todayInZone } from "../lib/zone";
import { test, expect, settled } from "./fixtures";
import { BIG, COMMITMENT, SMALL, asPerson, createButton, months, plus, planText, rawGoal, rawTask, seedOf, stored, toOpenReview, unfold } from "./importar-plan";

// The review's sheets change more than names (906): a commitment's cadence and amount, a goal's end.
// The boards are `ImportarHojaCompromiso` and `ImportarHojaMeta`.

const sheet = (page: Page) => page.getByRole("dialog");
const pencilOf = (page: Page, name: string) => page.getByRole("button", { name: `Cambiar el nombre de ${name}` });

test.describe("the sheet of a commitment (906)", () => {
  test("it offers the five cadences, changes how often and how much, and what is written follows", async ({ person, browser, baseURL, db }) => {
    // Kills: a sheet that keeps the plan's cadence, or that writes days on a counted cadence.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText({ rhythm: false }));
      await pencilOf(page, COMMITMENT).click();
      await expect(sheet(page).getByText(messages.review.edit.titleOf.commitment, { exact: true })).toBeVisible();
      await expect(sheet(page).getByRole("radio")).toHaveCount(5);
      await expect(sheet(page).getByRole("radio", { name: plan.commitmentForm.cadence.weekdays })).toBeChecked();
      await expect(sheet(page).getByRole("spinbutton", { name: messages.review.edit.hours })).toHaveValue("2");

      await sheet(page).getByRole("radio", { name: plan.commitmentForm.cadence.times_per_week }).click();
      await sheet(page).getByRole("spinbutton", { name: plan.commitmentForm.timesPerWeekLabel }).fill("3");
      await sheet(page).getByRole("spinbutton", { name: messages.review.edit.hours }).fill("0");
      await sheet(page).getByRole("spinbutton", { name: messages.review.edit.minutes }).fill("45");
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(sheet(page)).toHaveCount(0);

      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [row] = await db`select cadence_kind, cadence_n, cadence_weekdays, target_quantity from goals.commitments where user_id = ${person.id} and name = ${COMMITMENT}`;
      expect(row).toMatchObject({ cadence_kind: "times_per_week", cadence_n: 3, cadence_weekdays: null, target_quantity: 45 });
    });
  });

  test("days left empty are refused in the sheet, which stays open; a single day saves", async ({ person, browser, baseURL, db }) => {
    // Kills: closing the sheet on a cadence the table would refuse.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText({ rhythm: false }));
      await pencilOf(page, COMMITMENT).click();
      for (const day of ["M", "J"]) await sheet(page).getByRole("button", { name: day, exact: true }).click();
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(sheet(page).getByText(plan.errors.weekdaysEmpty)).toBeVisible();

      await sheet(page).getByRole("button", { name: "D", exact: true }).click();
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(sheet(page)).toHaveCount(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [row] = await db`select cadence_kind, cadence_weekdays from goals.commitments where user_id = ${person.id} and name = ${COMMITMENT}`;
      expect(row).toMatchObject({ cadence_kind: "weekdays", cadence_weekdays: [7] });
    });
  });

  test("when the plan named a day and the reading did not keep it, the sheet says so", async ({ person, browser, baseURL }) => {
    // Kills: the sentence missing, or showing for a commitment whose days were kept.
    const lines = ["# Inglés", "- Inglés pasivo · Domingo · 30 min"];
    const seed = seedOf(
      [
        rawGoal("Inglés", {
          measure: { name: "horas", unit: "minutos" },
          src: [{ from: 1, to: 1 }],
          commitments: [
            { name: "Inglés pasivo", cadenceKind: "times_per_week", cadenceWeekdays: null, cadenceN: 1, satisfaction: "quantity", targetQuantity: 30, unit: "minutos", src: [{ from: 2, to: 2 }] },
          ],
        }),
      ],
      { source: { kind: "lines", lines } },
    );
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), ["pulsar.import-draft", JSON.stringify(stored(seed))] as const);
      await page.goto("/metas/importar/revisar");
      await settled(page);
      await unfold(page);
      await pencilOf(page, "Inglés pasivo").click();
      await expect(sheet(page).getByText("Tu plan decía «Domingo». Se leyó como 1 vez por semana: elige «días sueltos» para dejarlo en domingo.")).toBeVisible();
      await sheet(page).getByRole("radio", { name: plan.commitmentForm.cadence.weekdays }).click();
      await expect(sheet(page).getByText(/Tu plan decía/)).toHaveCount(0);
    });
  });
});

test.describe("the sheet of a goal (906)", () => {
  const typed = (page: Page) => sheet(page).getByRole("spinbutton");

  test("its end is a number of weeks, with the day it ends on; a goal inside that ends later refuses it", async ({ person, browser, baseURL }) => {
    // Kills: no way to change an end in the review, or an end shorter than a goal inside it.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText({ rhythm: false }));
      await pencilOf(page, BIG).click();
      await expect(sheet(page).getByText(messages.review.edit.titleOf.big, { exact: true })).toBeVisible();
      const now = horizonWeeksOf(todayInZone(), plus(400));
      await expect(typed(page)).toHaveValue(String(now));
      await typed(page).fill("20");
      await expect(sheet(page).getByText(new RegExp(`«${SMALL}» termina el .+ después de ese día`))).toBeVisible();
      await expect(sheet(page).getByRole("button", { name: messages.review.edit.save })).toBeDisabled();
    });
  });

  test("a fitting end is saved and written", async ({ person, browser, baseURL, db }) => {
    // Kills: a saved end that is not the one written.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText({ rhythm: false }));
      await pencilOf(page, BIG).click();
      const weeks = horizonWeeksOf(todayInZone(), plus(350));
      await typed(page).fill(String(weeks));
      await expect(sheet(page).getByText(/^termina el/)).toBeVisible();
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(sheet(page)).toHaveCount(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [row] = await db`select horizon::text as horizon from goals.goals where user_id = ${person.id} and name = ${BIG}`;
      expect(row.horizon).toBe(horizonForWeeks(todayInZone(), weeks));
    });
  });
});

test.describe("a task the plan marked done (906)", () => {
  test("the review says it is done on its day, and it is written done", async ({ person, browser, baseURL, db }) => {
    // Kills: a done task shown or written as pending.
    const { first } = months();
    const day = plus(-1) < `${first}-01` ? todayInZone() : plus(-1);
    const seed = seedOf([rawGoal("Meta con hecha", { measure: { name: "horas", unit: "minutos" }, tasks: [rawTask("EF SET", { estimate: 1 }), rawTask("Medir")] })]);
    const value = stored(seed);
    value.draft.goals[0].tasks[0].doneOn = day;
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.evaluate(([key, text]) => sessionStorage.setItem(key, text), ["pulsar.import-draft", JSON.stringify(value)] as const);
      await page.goto("/metas/importar/revisar");
      await settled(page);
      await unfold(page);
      await expect(page.getByText(/tarea · hecha el \d+ \S+ \d{4}/)).toHaveCount(1);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await db`select o.name, f.day::text as day from goals.one_offs o left join goals.facts f on f.one_off_id = o.id
        where o.user_id = ${person.id} and o.name in ('EF SET', 'Medir') order by o.name`;
      expect(rows.map((r) => [r.name, r.day])).toEqual([["EF SET", day], ["Medir", null]]);
    });
    void goalMessages;
  });

  test("a sub-task marked done is done on its day, its parent and sister are not", async ({ person, browser, baseURL, db }) => {
    // Kills: a done line the model made a sub-task of, written pending.
    const day = todayInZone();
    const seed = seedOf([
      rawGoal("Meta con hija hecha", { measure: { name: "horas", unit: "minutos" }, tasks: [rawTask("Semana 1", { children: [{ name: "EF SET", estimate: 60, rule: null, noteSrc: [], noteText: null, src: [] }, { name: "Medir", estimate: 30, rule: null, noteSrc: [], noteText: null, src: [] }] })] }),
    ]);
    const value = stored(seed);
    value.draft.goals[0].tasks[0].children[0].doneOn = day;
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.evaluate(([key, text]) => sessionStorage.setItem(key, text), ["pulsar.import-draft", JSON.stringify(value)] as const);
      await page.goto("/metas/importar/revisar");
      await settled(page);
      await unfold(page);
      await page.getByRole("button", { name: /sub-tareas?$/ }).first().click();
      await expect(page.getByText(/sub-tarea · hecha el \d+ \S+ \d{4}/)).toHaveCount(1);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await db`select o.name, f.day::text as day from goals.one_offs o left join goals.facts f on f.one_off_id = o.id
        where o.user_id = ${person.id} and o.name in ('Semana 1', 'EF SET', 'Medir') order by o.name`;
      expect(rows.map((r) => [r.name, r.day])).toEqual([["EF SET", day], ["Medir", null], ["Semana 1", null]]);
    });
  });
});
