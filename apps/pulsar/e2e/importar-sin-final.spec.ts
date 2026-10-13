import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { dayBefore, horizonForWeeks } from "../lib/day/weeks";
import { civilDayMonthYear, todayInZone } from "../lib/zone";
import type { RawDraft } from "../lib/import/draft";
import { test, expect } from "./fixtures";
import { asPerson, createButton, months, plus, toOpenReview, toOpenSeededReview, word, type Seed } from "./importar-plan";

// The review of a goal with no end and of a rhythm in pages (RP-99, RP-102; module 918). The boards
// are `ImportarSinFinal-1-revision-360` and `-2-hoja-360`. No model is called: the plan is the template
// (`ritmo: 40 páginas`, no `horizonte:`) or a draft the model seam would have left in the tab's storage.

const READ = "Leer";
const DESIGNER = "Product Designer junior";
const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const dayWord = (date: string) => `${Number(date.slice(8, 10))} ${ABBR[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const NO_END = "meta · sin final";
const RHYTHM_LINE = "ritmo · cada mes sin monto lo toma";
const TASKS_GO_TO_PLAN = "las tareas van al plan";
const PUT_END = "ponerle final";

const sheet = (page: Page) => page.getByRole("dialog");
const pencil = (page: Page, name: string) => page.getByRole("button", { name: `Cambiar el nombre de ${name}`, exact: true });
const weeksField = (page: Page) => sheet(page).getByLabel(/^semanas, contando la del/);
const rowOf = (page: Page, name: RegExp) => page.locator("div").filter({ has: page.getByRole("checkbox", { name }) }).last();
const draftOf = (page: Page) => page.evaluate(() => sessionStorage.getItem("pulsar.import-draft"));
const wipe = (db: import("postgres").Sql, id: string) =>
  db`delete from goals.goals where user_id = ${id} and name in ('Leer', 'Product Designer junior', 'Padre', 'Hijo')`;

// The board's plan: «Leer» with no end, a rhythm of 40 pages a month, a daily commitment of 10 pages;
// «Product Designer junior» ending a year from now.
function boardPlan(extra = ""): string {
  const { first } = months();
  return [
    "pulsar · plantilla 2",
    "",
    `# ${READ}`,
    "medida: lectura · páginas",
    "ritmo: 40 páginas",
    "",
    "## Meses",
    `- ${first} · 30 páginas`,
    ...(extra ? [extra] : []),
    "",
    "## Compromisos",
    "- Leer 10 páginas · cada día · 10 páginas",
    "",
    `# ${DESIGNER}`,
    `horizonte: ${plus(400)}`,
  ].join("\n");
}

// A parent and the goal inside it; each end given or not.
function pairPlan(parentEnd: string | null, childEnd: string | null): string {
  return [
    "pulsar · plantilla 2",
    "",
    "# Padre",
    ...(parentEnd ? [`horizonte: ${parentEnd}`] : []),
    "",
    "# Hijo",
    ...(childEnd ? [`horizonte: ${childEnd}`] : []),
    "dentro de: Padre",
  ].join("\n");
}

const range = (n: number) => [{ from: n, to: n }];
function modelSeed(): Seed {
  const raw: RawDraft = {
    goals: [
      {
        key: "leer",
        parent: null,
        name: READ,
        horizon: null,
        measure: { name: "lectura", unit: "páginas" },
        rate: { amount: 40, unit: "units", per: "month" },
        noteSrc: [],
        noteText: null,
        src: range(1),
        phases: [],
        months: [],
        commitments: [],
        rules: [],
        tasks: [],
      },
    ],
  };
  return { raw, source: { kind: "lines", lines: ["Leer", "40 páginas al mes"] } };
}

test.describe("the review of a goal with no end (RP-99)", () => {
  test("its row says «sin final» where a dated goal says «hasta el …», and never a date", async ({ person, browser, baseURL }) => {
    // Kills: `dayBefore(null)` / writing `horizonUntil` whatever the horizon.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      await expect(page.getByText(NO_END, { exact: true })).toHaveCount(1);
      await expect(rowOf(page, new RegExp(`^${READ} meta`))).not.toContainText("hasta el");
      await expect(rowOf(page, new RegExp(`^${READ} meta`))).not.toContainText(/NaN|Invalid|undefined|null/);
      // The dated goal keeps its words, with the day before its horizon.
      await expect(page.getByText(`meta · hasta el ${dayWord(dayBefore(plus(400)))}`, { exact: true })).toBeVisible();
      await expect(createButton(page)).toHaveText("Crear 2 metas");
    });
  });

  test("a goal with no end lists its months up to eleven after the current one and no further", async ({ person, browser, baseURL }) => {
    // Kills: `monthsOfSpan` without today, a span that ends at the opening, or one that ends with `null` read as «now».
    const { later } = months(); // ten months ahead
    const [year, month] = todayInZone().split("-").map(Number);
    const shift = (by: number) => {
      const index = year * 12 + (month - 1) + by;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
    };
    const eleventh = shift(11);
    const twelfth = shift(12);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan(`- ${later} · 20 páginas\n- ${eleventh} · 25 páginas\n- ${twelfth} · 5 páginas`));
      await expect(page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(eleventh)}`, "i") })).toHaveText("25 páginas");
      await expect(page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(later)}`, "i") })).toHaveText("20 páginas");
      // The twelfth month after is outside the span: it is left out, with no amount button of its own.
      await expect(page.getByText(messages.review.blocked.title, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: new RegExp(`^Cambiar el monto de ${word(twelfth)},? 5 páginas`, "i") })).toHaveCount(0);
    });
  });

  test("creating it writes a goal with no horizon, its rhythm of 40 pages and its commitment", async ({ person, browser, baseURL, db }) => {
    // Kills: writing a horizon the person never gave, or dropping the rhythm of a non-time measure.
    await asPerson({ person, browser, baseURL }, async (page) => {
      try {
        await toOpenReview(page, boardPlan());
        await createButton(page).click();
        await expect(page).toHaveURL(/\/metas$/);
        const [goal] = await db`select id, horizon, rhythm from goals.goals where user_id = ${person.id} and name = ${READ}`;
        expect(goal.horizon).toBeNull();
        expect(goal.rhythm).toBe(40);
        expect(await db`select 1 from goals.commitments where user_id = ${person.id} and goal_id = ${goal.id}`).toHaveLength(1);
        const [dated] = await db`select horizon::text as horizon from goals.goals where user_id = ${person.id} and name = ${DESIGNER}`;
        expect(dated.horizon).toBe(plus(400));
      } finally {
        await wipe(db, person.id);
      }
    });
  });
});

test.describe("the review of a rhythm in pages (RP-102)", () => {
  test("the rhythm row's figure is «40 páginas», in its own unit, with a button to change it", async ({ person, browser, baseURL }) => {
    // Kills: formatting the rhythm in hours («40 h», «0 h 40 min»), or drawing no figure for a non-time unit.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      const button = page.getByRole("button", { name: /^Cambiar el ritmo, 40 páginas al mes$/ });
      await expect(button).toHaveText("40 páginas");
      await expect(page.getByText(/\b40 (h|min)\b/)).toHaveCount(0);
    });
  });

  test("its line reads «ritmo · cada mes sin monto lo toma», and never says the tasks go to the plan", async ({ person, browser, baseURL }) => {
    // Kills: keeping `rhythmMeta` («las tareas van al plan») for every unit.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toHaveCount(1);
      await expect(page.getByText(new RegExp(TASKS_GO_TO_PLAN))).toHaveCount(0);
    });
  });

  test("the same row from a model's draft: rate in `units`, no horizon", async ({ person, browser, baseURL }) => {
    // Kills: a review that reads the rate only through the template, or one that assumes a rate is time.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenSeededReview(page, modelSeed());
      await expect(page.getByText(NO_END, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Cambiar el ritmo, 40 páginas al mes$/ })).toHaveText("40 páginas");
      await expect(page.getByText(RHYTHM_LINE, { exact: true })).toBeVisible();
    });
  });

  test("a time rhythm keeps its words, «las tareas van al plan»", async ({ person, browser, baseURL }) => {
    // Control: it passes now and must keep passing; kills a fix that changes the line for every unit.
    const text = ["pulsar · plantilla 2", "", "# Estudiar", `horizonte: ${plus(400)}`, "medida: estudio · minutos", "ritmo: 12 h"].join("\n");
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, text);
      await expect(page.getByText("ritmo · las tareas van al plan", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cambiar el ritmo, 12 h al mes" })).toHaveText("12 h");
    });
  });
});

test.describe("the sheet of a goal with no end (board `ImportarSinFinal-2-hoja-360`)", () => {
  test("it says «sin final» on the left and offers «ponerle final»; no weeks field until it is taken", async ({ person, browser, baseURL }) => {
    // Kills: a weeks field already open for a goal with no end, or a sheet with no way to give it one.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      await pencil(page, READ).click();
      await expect(sheet(page).getByText(messages.review.edit.titleOf.big, { exact: true })).toBeVisible();
      await expect(sheet(page).getByText(READ, { exact: true }).first()).toBeVisible();
      await expect(sheet(page).getByLabel(messages.review.edit.name)).toHaveValue(READ);
      await expect(sheet(page).getByText("sin final", { exact: true })).toBeVisible();
      await expect(sheet(page).getByRole("button", { name: PUT_END, exact: true })).toBeVisible();
      await expect(weeksField(page)).toHaveCount(0);
      // «sin final» sits left of «ponerle final» (board 2).
      const [said, button] = [
        (await sheet(page).getByText("sin final", { exact: true }).boundingBox())!,
        (await sheet(page).getByRole("button", { name: PUT_END, exact: true }).boundingBox())!,
      ];
      expect(said.x).toBeLessThan(button.x);
    });
  });

  test("«ponerle final» opens the weeks field; saving gives the row «hasta el …» and the draft that end", async ({ person, browser, baseURL }) => {
    // Kills: not writing the end into the draft, or writing a different day from the one the sheet announced.
    const [today] = [todayInZone()];
    const end = horizonForWeeks(today, 52);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      await pencil(page, READ).click();
      await sheet(page).getByRole("button", { name: PUT_END, exact: true }).click();
      await weeksField(page).fill("52");
      const last = dayBefore(end);
      await expect(sheet(page).getByText(`termina el ${civilDayMonthYear(last)}`)).toBeVisible();
      await sheet(page).getByRole("button", { name: messages.review.edit.save }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.getByText(`meta · hasta el ${dayWord(dayBefore(end))}`, { exact: true })).toHaveCount(1);
      await expect(page.getByText(NO_END, { exact: true })).toHaveCount(0);
      expect(JSON.parse((await draftOf(page))!).draft.goals[0].horizon).toBe(end);
    });
  });

  test("«Cancelar» after «ponerle final» leaves the row and the stored draft as they were", async ({ person, browser, baseURL }) => {
    // Kills: applying the typed end when the sheet closes.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      const before = await draftOf(page);
      await pencil(page, READ).click();
      await sheet(page).getByRole("button", { name: PUT_END, exact: true }).click();
      await weeksField(page).fill("30");
      await sheet(page).getByRole("button", { name: messages.review.edit.cancel }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.getByText(NO_END, { exact: true })).toHaveCount(1);
      expect(await draftOf(page)).toBe(before);
    });
  });

  test("a goal with an end can lose it from its sheet: «Quitar el final» then «Guardar» gives «sin final» (P3)", async ({ person, browser, baseURL }) => {
    // Kills: no way to remove an end, or a removal that is never written into the draft.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, boardPlan());
      await pencil(page, DESIGNER).click();
      await sheet(page).getByRole("button", { name: "Quitar el final", exact: true }).click();
      // The board does not say whether the button closes the sheet or waits for «Guardar».
      const save = sheet(page).getByRole("button", { name: messages.review.edit.save });
      if (await save.isVisible()) await save.click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(page.getByText(NO_END, { exact: true })).toHaveCount(2);
      expect(JSON.parse((await draftOf(page))!).draft.goals[1].horizon).toBeNull();
    });
  });
});

test.describe("a goal with no end under a goal with an end (RP-99, P2)", () => {
  test("a goal with no end inside one with an end is left out, and says why in its place", async ({ person, browser, baseURL }) => {
    // Kills: omitting the refusal, so the child is created with no end under a parent that has one.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, pairPlan(plus(400), null));
      await expect(page.getByText("“Hijo” no tiene final: dale uno antes.", { exact: true })).toBeVisible();
      await expect(createButton(page)).toHaveText("Crear 1 meta");
    });
  });

  test("giving an end to a goal that holds one with none is refused in the sheet, naming it", async ({ person, browser, baseURL }) => {
    // Kills: letting «Padre» take an end while «Hijo» has none, or a refusal that does not name the goal.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, pairPlan(null, null));
      const before = await draftOf(page);
      await pencil(page, "Padre").click();
      await sheet(page).getByRole("button", { name: PUT_END, exact: true }).click();
      await weeksField(page).fill("52");
      await expect(sheet(page).getByText("“Hijo” no tiene final: dale uno antes.", { exact: true })).toBeVisible();
      await expect(sheet(page).getByRole("button", { name: messages.review.edit.save })).toBeDisabled();
      await sheet(page).getByRole("button", { name: messages.review.edit.cancel }).click();
      expect(await draftOf(page)).toBe(before);
    });
  });
});
