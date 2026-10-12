import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { PHASE, SMALL, SUB_B, TASK_A, TASK_B, asPerson, createButton, months, planText, toReview, word } from "./importar-plan";

// One sheet changes a part's name, amount or month (RP-89). The board is `ImportarCambiar`: the
// sheet carries only the fields the part has, «Cancelar» leaves everything as it was.

const sheet = (page: Page) => page.getByRole("dialog");
const amountOf = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${name}`, "i") });
const nameOf = (page: Page, name: string) => page.getByRole("button", { name: `Cambiar el nombre de ${name}` });

test.describe("changing a part from the end of its row (RP-89)", () => {
  test("a task's sheet offers its name, hours and minutes and the goal's months; saving changes what is written", async ({ person, browser, baseURL, db }) => {
    // Kills: ignoring the month, the amount or the name the sheet saved.
    const { first, second } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await amountOf(page, TASK_B).click();
      await expect(sheet(page).getByText(messages.review.edit.titleOf.task, { exact: true })).toBeVisible();
      await expect(sheet(page).getByText(SMALL, { exact: true })).toBeVisible();
      await expect(sheet(page).getByLabel(messages.review.edit.name)).toHaveValue(TASK_B);
      await expect(sheet(page).getByRole("spinbutton", { name: messages.review.edit.hours })).toHaveValue("6");
      await expect(sheet(page).getByRole("radio", { name: word(second) })).toBeChecked();
      await expect(sheet(page).getByRole("radio", { name: word(first) })).not.toBeChecked();

      await sheet(page).getByLabel(messages.review.edit.name).fill("Entregar el caso final");
      await sheet(page).getByRole("spinbutton", { name: messages.review.edit.hours }).fill("7");
      await sheet(page).getByRole("spinbutton", { name: messages.review.edit.minutes }).fill("15");
      await sheet(page).getByRole("radio", { name: word(first) }).check();
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(page.getByRole("checkbox", { name: /^Entregar el caso final/ })).toBeVisible();
      await expect(amountOf(page, "Entregar el caso final")).toHaveText("7 h 15 min");

      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const [task] = await db`select name, estimate, planned_month::text as month from goals.one_offs where user_id = ${person.id} and name = 'Entregar el caso final'`;
      expect(task).toMatchObject({ estimate: 435, month: `${first}-01` });
      expect(await db`select 1 from goals.one_offs where user_id = ${person.id} and name = ${TASK_B}`).toHaveLength(0);
    });
  });

  test("a phase has no amount: a pencil opens a sheet with its name alone", async ({ person, browser, baseURL, db }) => {
    // Kills: no way to rename a part that has no figure, or a sheet with fields the part lacks.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await nameOf(page, PHASE).click();
      await expect(sheet(page).getByText(messages.review.edit.titleOf.phase, { exact: true })).toBeVisible();
      await expect(sheet(page).getByLabel(messages.review.edit.name)).toHaveValue(PHASE);
      await expect(sheet(page).getByRole("spinbutton")).toHaveCount(0);
      await expect(sheet(page).getByRole("radio")).toHaveCount(0);
      await sheet(page).getByLabel(messages.review.edit.name).fill("Portafolio y primer caso");
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(page.getByRole("checkbox", { name: /^Portafolio y primer caso/ })).toBeVisible();

      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(await db`select 1 from goals.phases where user_id = ${person.id} and aim = 'Portafolio y primer caso'`).toHaveLength(1);
    });
  });

  test("a month's sheet carries its amount alone", async ({ person, browser, baseURL }) => {
    // Kills: giving a month a name or a month field.
    const { first } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await amountOf(page, word(first)).click();
      await expect(sheet(page).getByText(messages.review.edit.titleOf.month, { exact: true })).toBeVisible();
      await expect(sheet(page).getByRole("spinbutton", { name: messages.review.edit.hours })).toBeVisible();
      await expect(sheet(page).getByLabel(messages.review.edit.name)).toHaveCount(0);
      await expect(sheet(page).getByRole("radio")).toHaveCount(0);
    });
  });

  test("«Cancelar» leaves the part as it was, and so does a reload", async ({ person, browser, baseURL }) => {
    // Kills: saving what was typed when the sheet closes.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      await amountOf(page, TASK_A).click();
      await sheet(page).getByLabel(messages.review.edit.name).fill("Otro nombre");
      await sheet(page).getByRole("spinbutton", { name: messages.review.edit.hours }).fill("9");
      await sheet(page).getByRole("button", { name: messages.review.edit.cancel }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: new RegExp(`^${TASK_A}`) })).toBeVisible();
      await expect(amountOf(page, TASK_A)).toHaveText("4 h");
      await page.reload();
      await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
      await expect(amountOf(page, TASK_A)).toHaveText("4 h");
      await expect(page.getByRole("checkbox", { name: /^Otro nombre/ })).toHaveCount(0);
      void SUB_B;
    });
  });
});
