import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import {
  asPerson,
  createButton,
  months,
  plus,
  readWithTemplate,
  streamInPlaceOfModel,
  toOpenReview,
  toReview,
  unfold,
  word,
} from "./importar-plan";

// RP-122, boards `ImportarComoEscribiste` faces 1 to 3: a plan written in the template is saved as it was
// written; each correction starts declined and the person accepts the ones she wants. A model's reading
// starts with its corrections accepted.

const GOAL = "Carrera en IA";
const { first, second } = months();
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const amountButton = (page: Page, month: string) => page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${month}`, "i") });
const kept = (said: string) => messages.review.correction.keepsPlan.replace("{said}", said);

// Two months that disagree with their tasks (12 h said, 4 h + 7 h written; 20 h said, 8 h written) under a rhythm of 20 h, so only the sums disagree.
const K7 = [
  "pulsar · plantilla 2",
  "",
  `# ${GOAL}`,
  `horizonte: ${plus(300)}`,
  "medida: horas de estudio · minutos",
  "ritmo: 20 h",
  "",
  "## Meses",
  `- ${first} · 12 h`,
  `- ${second} · 20 h`,
  "",
  "## Tareas",
  `- ${first} · 4 h · Leer capítulo`,
  `- ${first} · 7 h · Practicar`,
  `- ${second} · 8 h · Entregar caso`,
].join("\n");

const monthRows = (db: import("postgres").Sql, id: string) => db`
  select b.month::text as month, b.amount from goals.month_budgets b join goals.goals g on g.id = b.goal_id
  where b.user_id = ${id} and g.name = ${GOAL} order by b.month`;

test.afterEach(async ({ db, person }) => {
  await db`delete from goals.goals where user_id = ${person.id}`;
});

test.describe("a plan from the template is saved as written (RP-122)", () => {
  test("face 1: «Crear» without opening anything writes the months as written, 12 h and 20 h", async ({ person, browser, baseURL, db }) => {
    // Kills: `saveDraft` storing `declined: []` for a template, so the untouched sums are written instead.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, K7);
      expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await monthRows(db, person.id);
      expect(rows.map((r) => [r.month, r.amount])).toEqual([[`${first}-01`, 720], [`${second}-01`, 1200]]);
    });
  });

  test("face 1: just read, the goal's summary does not say «por revisar»", async ({ person, browser, baseURL }) => {
    // Kills: counting corrections nobody touched as pending in the summary.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, K7);
      await expect(page.getByRole("button", { name: /^Sus partes/ }).first()).toBeVisible();
      await expect(page.getByText(/por revisar/)).toHaveCount(0);
    });
  });

  test("face 2: an opened month shows the figure written, «Se queda como decía el plan» and «Aceptar la corrección», with no proposal drawn", async ({ person, browser, baseURL }) => {
    // Kills: drawing the proposal first, or a declined correction with no way back.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await expect(amountButton(page, word(second))).toHaveText("20 h");
      await expect(page.getByText(kept("20 h"), { exact: true })).toBeVisible();
      await expect(amountButton(page, word(first))).toHaveText("12 h");
      await expect(page.getByText(kept("12 h"), { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: messages.review.correction.acceptDeclined })).toHaveCount(2);
      await expect(page.getByRole("button", { name: messages.review.correction.decline, exact: true })).toHaveCount(0);
      await expect(page.getByText(messages.review.correction.proposed, { exact: true })).toHaveCount(0);
    });
  });

  test("face 3: «Aceptar la corrección» draws the proposal with «Dejar como estaba»; the other month stays as written", async ({ person, browser, baseURL }) => {
    // Kills: accepting one month moving the other, or no way back from it. The board's single button is 993's.
    const month = word(second);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await expect(page.getByRole("button", { name: messages.review.correction.acceptDeclined })).toHaveCount(2);
      await page.getByRole("button", { name: messages.review.correction.acceptDeclined }).last().click();
      await expect(amountButton(page, month)).toHaveText("8 h");
      await expect(page.getByText(`${cap(month)}: 20 h`, { exact: true })).toBeVisible();
      await expect(page.getByText(`${cap(month)}: 8 h`, { exact: true })).toBeVisible();
      await expect(page.getByText(new RegExp(`^Las tareas de ${month} suman 8 h`))).toBeVisible();
      await expect(page.getByRole("button", { name: messages.review.correction.decline, exact: true })).toHaveCount(1);
      await expect(amountButton(page, word(first))).toHaveText("12 h");
    });
  });

  test("the month the person accepted is written as the sum, the other as written", async ({ person, browser, baseURL, db }) => {
    // Kills: ignoring an acceptance when creating, or accepting every correction on «Crear».
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await expect(page.getByRole("button", { name: messages.review.correction.acceptDeclined })).toHaveCount(2);
      await page.getByRole("button", { name: messages.review.correction.acceptDeclined }).last().click();
      await expect(amountButton(page, word(second))).toHaveText("8 h");
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await monthRows(db, person.id);
      expect(rows.map((r) => [r.month, r.amount])).toEqual([[`${first}-01`, 720], [`${second}-01`, 480]]);
    });
  });
});

test.describe("a model's reading keeps its corrections accepted (RP-122)", () => {
  test("the same plan read by the model writes the sums,", async ({ person, browser, baseURL, db }) => {
    // Kills: declining the model's corrections too.
    await asPerson({ person, browser, baseURL }, async (page) => {
      const done = await readWithTemplate(page, K7);
      await streamInPlaceOfModel(page, { done: { ...done, via: "model" } }, 0);
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel, { exact: true }).fill("Quiero estudiar IA dos horas al día.");
      await page.getByRole("button", { name: messages.read }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
      await expect(page.getByText(messages.review.correction.acceptDeclined, { exact: true })).toHaveCount(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await monthRows(db, person.id);
      expect(rows.map((r) => [r.month, r.amount])).toEqual([[`${first}-01`, 660], [`${second}-01`, 480]]);
    });
  });
});

// RP-122 / RP-89, board face 3: one tap accepts, and the panel that stays offers «Dejar como estaba» alone.
test.describe("«Aceptar la corrección» accepts in one tap (993)", () => {
  const acceptDeclined = (page: Page) => page.getByRole("button", { name: messages.review.correction.acceptDeclined });
  const decline = (page: Page) => page.getByRole("button", { name: messages.review.correction.decline, exact: true });
  const accept = (page: Page) => page.getByRole("button", { name: messages.review.correction.accept, exact: true });

  test("one tap: the row says 8 h, the panel offers no «Aceptar», and «Crear» writes 8 h", async ({ person, browser, baseURL, db }) => {
    // Kills: `onUndo` lifting the refusal without marking the correction accepted (a second «Aceptar» stays).
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await acceptDeclined(page).last().click();
      await expect(amountButton(page, word(second))).toHaveText("8 h");
      await expect(decline(page)).toHaveCount(1);
      await expect(accept(page)).toHaveCount(0);
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await monthRows(db, person.id);
      expect(rows.map((r) => [r.month, r.amount])).toEqual([[`${first}-01`, 720], [`${second}-01`, 480]]);
    });
  });

  test("back: «Dejar como estaba» restores the written 20 h and «Crear» writes it; the button to accept again is one tap too", async ({ person, browser, baseURL, db }) => {
    // Kills: an acceptance with no way back.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await acceptDeclined(page).last().click();
      await decline(page).click();
      await expect(page.getByText(kept("20 h"), { exact: true })).toBeVisible();
      await expect(amountButton(page, word(second))).toHaveText("20 h");
      await acceptDeclined(page).last().click();
      await expect(accept(page)).toHaveCount(0);
      await decline(page).click();
      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const rows = await monthRows(db, person.id);
      expect(rows.map((r) => [r.month, r.amount])).toEqual([[`${first}-01`, 720], [`${second}-01`, 1200]]);
    });
  });

  test("reload: the accepted month is still applied, 8 h", async ({ person, browser, baseURL }) => {
    // Kills: keeping the decision in memory alone.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await acceptDeclined(page).last().click();
      await expect(amountButton(page, word(second))).toHaveText("8 h");
      await page.reload();
      await unfold(page);
      await expect(amountButton(page, word(second))).toHaveText("8 h");
    });
  });

  test("while «Crear» runs, «Aceptar la corrección» and «Dejar como estaba» are disabled", async ({ person, browser, baseURL }) => {
    // Kills: dropping `disabled` from the correction buttons.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, K7);
      await acceptDeclined(page).last().click();
      await expect(decline(page)).toHaveCount(1);
      await page.route("**/metas/importar/revisar", async (route) => {
        if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
      });
      await createButton(page).click();
      await expect(page.getByRole("button", { name: messages.review.creating })).toBeDisabled();
      await expect(decline(page)).toBeDisabled();
      await expect(acceptDeclined(page).first()).toBeDisabled();
      await expect(page).toHaveURL(/\/metas$/);
    });
  });
});
