import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import {
  BIG,
  COMMITMENT,
  GENERAL,
  GENERAL_NOTE_1,
  GENERAL_NOTE_2,
  PHASE,
  SMALL,
  SUB_A,
  SUB_B,
  TASK_A,
  TASK_B,
  WEEK,
  WEEK_NOTE,
  asPerson,
  countOf,
  createButton,
  lineOf,
  months,
  nonBlank,
  plus,
  planText,
  toOpenReview,
  word,
} from "./importar-plan";
import { boxOf } from "./box";

// The review as one tree (RP-89, RP-96, RP-97). The boards are `ImportarArbol`, `ImportarFuera` and
// `ImportarNadaQueCrear`: every word and where it sits is theirs. The plan is the template, read on
// the server with no model.

const box = (page: Page, name: string | RegExp) => page.getByRole("checkbox", { name });
const x = async (page: Page, name: RegExp) => (await boxOf(box(page, name))).x;
const backName = /tu texto/;

test.describe("the review draws the plan as a tree (RP-89)", () => {
  test("three levels of goal, with a phase, a week and a task under their goal, each saying its class, 16 px a level", async ({ person, browser, baseURL }) => {
    // Kills: drawing the rows flat, or a fixed step per level that is not 16 px.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText());
      await expect(page.getByText(messages.review.hint, { exact: true })).toBeVisible();

      await expect(box(page, new RegExp(`^${GENERAL}`))).toHaveAccessibleName(/meta general/);
      await expect(box(page, new RegExp(`^${BIG}`))).toHaveAccessibleName(/meta grande/);
      await expect(box(page, new RegExp(`^${SMALL}`))).toHaveAccessibleName(/meta pequeña/);
      await expect(box(page, new RegExp(`^${PHASE}`))).toHaveAccessibleName(/fase/);
      await expect(box(page, new RegExp(`^${COMMITMENT}`))).toHaveAccessibleName(/compromiso/);
      await expect(box(page, new RegExp(`^${WEEK}`))).toHaveAccessibleName(/tarea/);
      await expect(box(page, new RegExp(`^${TASK_A}`))).toHaveAccessibleName(/tarea/);
      await expect(box(page, new RegExp(`^${word(months().first)}`, "i"))).toHaveAccessibleName(/mes/);

      await page.getByRole("button", { name: /2 sub-tareas/ }).click();
      await expect(box(page, new RegExp(`^${SUB_A}`))).toHaveAccessibleName(/sub-tarea/);

      const g = await x(page, new RegExp(`^${GENERAL}`));
      const steps = [
        [BIG, 1],
        [SMALL, 2],
        [PHASE, 3],
        [WEEK, 3],
        [TASK_A, 3],
        [SUB_A, 4],
        [SUB_B, 4],
      ] as const;
      for (const [name, depth] of steps) {
        expect(Math.abs((await x(page, new RegExp(`^${name}`))) - (g + 16 * depth)), name).toBeLessThanOrEqual(1);
      }
      // Only the small goal's parts hang under it: «Crear 3 metas», one per goal.
      await expect(createButton(page)).toHaveText("Crear 3 metas");
    });
  });

  test("a task's sub-tasks and a part's note stay folded until their button is pressed", async ({ person, browser, baseURL }) => {
    // Kills: drawing the sub-tasks and notes open, or a note that loses its line break.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planText());
      await expect(page.getByText(SUB_A)).toHaveCount(0);
      await expect(page.getByText(GENERAL_NOTE_1)).toHaveCount(0);
      await expect(page.getByText(WEEK_NOTE)).toHaveCount(0);

      await page.getByRole("button", { name: "2 sub-tareas" }).click();
      await expect(box(page, new RegExp(`^${SUB_A}`))).toBeVisible();
      await expect(box(page, new RegExp(`^${SUB_B}`))).toBeVisible();

      await page.getByRole("button", { name: "nota · 2 líneas" }).click();
      const note = page.getByText(GENERAL_NOTE_1).first();
      await expect(note).toBeVisible();
      expect(await note.evaluate((el) => (el as HTMLElement).innerText)).toBe(`${GENERAL_NOTE_1}\n${GENERAL_NOTE_2}`);
      await page.getByRole("button", { name: "nota · 1 línea" }).click();
      await expect(page.getByText(WEEK_NOTE)).toBeVisible();
    });
  });
});

test.describe("the count says where every line of the text went (RP-96)", () => {
  test("«N líneas: P en el plan, M en notas, F fuera» counts the text's lines, and leaving a big goal out raises «fuera» by its lines", async ({ person, browser, baseURL }) => {
    // Kills: a count that ignores what the person unmarked, or that counts blank lines.
    const text = planText();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, text);
      const whole = await countOf(page);
      expect(whole.total).toBe(nonBlank(text));
      expect(whole.plan + whole.notes + whole.out).toBe(whole.total);
      expect(whole.out).toBe(0);
      expect(whole.notes).toBeGreaterThan(0);

      await box(page, new RegExp(`^${BIG}`)).uncheck();
      const below = text.split("\n").slice(lineOf(text, `# ${BIG}`) - 1).filter((line) => line.trim() !== "").length;
      await expect.poll(async () => (await countOf(page)).out).toBe(below);
      const after = await countOf(page);
      expect(after.total).toBe(whole.total);
      expect(after.plan + after.notes + after.out).toBe(after.total);
      // The small goal under it goes with it, and one goal is left to create.
      await expect(box(page, new RegExp(`^${SMALL}`))).not.toBeChecked();
      await expect(createButton(page)).toHaveText("Crear 1 meta");
    });
  });

  test("a part the person leaves out is listed under «las dejaste fuera» with its line, and marking it there puts it back", async ({ person, browser, baseURL }) => {
    // Kills: no way back for a part left out, or a line number that is not the text's own.
    const text = planText();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, text);
      await page.getByRole("button", { name: "2 sub-tareas" }).click();
      await box(page, new RegExp(`^${SUB_B}`)).uncheck();

      await expect(page.getByText(messages.review.left.hint, { exact: true })).toBeVisible();
      const section = page.getByText(messages.review.left.title, { exact: true }).locator("xpath=..");
      await expect(section).toContainText(SUB_B);
      await expect(section).toContainText(`línea ${lineOf(text, SUB_B)}`);
      await expect.poll(async () => (await countOf(page)).out).toBe(1);

      await section.getByRole("checkbox", { name: new RegExp(SUB_B) }).check();
      await expect(box(page, new RegExp(`^${SUB_B}`))).toBeChecked();
      await expect.poll(async () => (await countOf(page)).out).toBe(0);
      await expect(page.getByText(messages.review.left.title, { exact: true })).toHaveCount(0);
    });
  });
});

test.describe("what cannot be created is listed, and a plan with nothing to create has no button (RP-90, RP-97)", () => {
  test("a task past its goal's end is listed under «No se puede crear» with its line and its reason, and cannot be marked", async ({ person, browser, baseURL }) => {
    // Kills: hiding a refused part, or giving it a box that marks it back in.
    const { first, later } = months();
    const text = [
      "pulsar · plantilla 2",
      "",
      "# Caso uno",
      `horizonte: ${plus(120)}`,
      "medida: horas · minutos",
      "",
      "## Tareas",
      `- ${first} · 2 h · Tarea viva`,
      `- ${later} · 2 h · Tarea tardía`,
    ].join("\n");
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, text);
      await expect(page.getByText(messages.review.blocked.hint, { exact: true })).toBeVisible();
      const section = page.getByText(messages.review.blocked.title, { exact: true }).locator("xpath=..");
      await expect(section).toContainText("Tarea tardía");
      await expect(section).toContainText(`línea ${lineOf(text, "Tarea tardía")}`);
      await expect(section).toContainText(/queda después del final de la meta, el \d{1,2} \S+ \d{4}/);
      await expect(section).not.toContainText("Tarea viva");
      await expect(box(page, /^Tarea tardía/).first()).toBeDisabled();
      await expect(box(page, /^Tarea tardía/).first()).not.toBeChecked();
      await expect.poll(async () => (await countOf(page)).out).toBe(1);
    });
  });

  test("when every goal is refused the review says «Nada que crear» and offers no way to create", async ({ person, browser, baseURL }) => {
    // Kills: a create button that is only disabled, or an empty review with no sentence.
    const text = ["pulsar · plantilla 2", "", "# Caso pasado", `horizonte: ${plus(-5)}`, "", "## Tareas", `- ${months().first} · Una tarea`].join("\n");
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, text);
      await expect(page.getByText(messages.review.nothing, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.errors.horizonPast, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Crear/ })).toHaveCount(0);
      const count = await countOf(page);
      expect(count.plan).toBe(0);
      expect(count.notes).toBe(0);
      expect(count.out).toBe(nonBlank(text));
      await expect(page.getByRole("link", { name: backName }).first()).toBeVisible();
    });
  });
});

test.describe("the way back to the text (RP-86)", () => {
  test("«tu texto» at the top of the review returns to the box with the text and writes nothing", async ({ person, browser, baseURL, db }) => {
    // Kills: clearing the draft on the way back.
    const text = planText();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, text);
      await page.getByRole("link", { name: backName }).first().click();
      await expect(page).toHaveURL(/\/metas\/importar$/);
      await expect(page.getByLabel(messages.textLabel, { exact: true })).toHaveValue(text);
    });
    expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
  });

  test("from 1024 px the original text stands read-only on the left with «Volver al texto» under it and the tree on the right", async ({ person, browser, baseURL, db }) => {
    // Kills: dropping the text column, or putting the tree under it.
    const text = planText();
    await asPerson(
      { person, browser, baseURL },
      async (page) => {
        await toOpenReview(page, text);
        const source = page.getByRole("textbox", { name: messages.review.sourceLabel, exact: true });
        await expect(source).toHaveValue(text);
        await expect(source).not.toBeEditable();
        const s = (await boxOf(source));
        expect(s.width).toBeGreaterThanOrEqual(280);
        expect(s.width).toBeLessThanOrEqual(360);
        const tree = (await boxOf(box(page, new RegExp(`^${GENERAL}`))));
        expect(tree.x).toBeGreaterThanOrEqual(s.x + s.width);
        const back = (await boxOf(page.getByRole("link", { name: messages.review.change })));
        expect(back.y).toBeGreaterThanOrEqual(s.y + s.height - 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

        await page.getByRole("link", { name: messages.review.change }).click();
        await expect(page.getByLabel(messages.textLabel, { exact: true })).toHaveValue(text);
      },
      { width: 1280, height: 900 },
    );
    expect(await db`select 1 from goals.goals where user_id = ${person.id}`).toHaveLength(0);
  });
});

test.describe("at 360 px nothing overflows and nothing to tap is small (RNP-07)", () => {
  const small = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main button, main a, main label:has(input)")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 30), box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.height < 32)
        .map(({ text, box }) => `${text} ${Math.round(box.width)}x${Math.round(box.height)}`),
    );

  test("the entry and the five-level tree, sub-tasks and notes open, fit the width and every control is at least 32 px tall", async ({ person, browser, baseURL }) => {
    // Kills: a fixed 24 px of indent a level (five levels run off a 360 px screen), or a short control.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await expect(page.getByRole("button", { name: messages.read })).toBeVisible();
      await expect(page.getByRole("button", { name: messages.entry.copyInstruction })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await small(page)).toEqual([]);

      await toOpenReview(page, planText());
      await page.getByRole("button", { name: "2 sub-tareas" }).click();
      await page.getByRole("button", { name: "nota · 2 líneas" }).click();
      await expect(box(page, new RegExp(`^${SUB_A}`))).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const sub = (await boxOf(box(page, new RegExp(`^${SUB_A}`))));
      expect(sub.x + sub.width).toBeLessThanOrEqual(360);
      expect(await small(page)).toEqual([]);
      void TASK_B;
    });
  });
});
