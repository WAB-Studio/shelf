import type { Locator, Page } from "@playwright/test";

import type { RawDraft, RawGoal, RawTask, Src } from "../lib/import/draft";
import { test, expect } from "./fixtures";
import {
  BIG,
  GENERAL,
  SMALL,
  asPerson,
  countOf,
  createButton,
  movedExample,
  planText,
  plus,
  rawGoal,
  rawTask,
  stored,
  toReview,
  toSeededReview,
  word,
  type Seed,
} from "./importar-plan";
import { boxOf } from "./box";

// The review of a long plan (module 902). The board is `ImportarRevisionLarga`; the decisions are the
// last section of docs/pulsar/DESIGN.md. The plan is the shape of a real roadmap, built with no model:
// five goals under one general, 51 tasks, 58 sub-tasks, a source of ~450 lines of which ~330 fall
// under no part, spread over named sections.

const monthAt = (by: number) => {
  const [year, month] = plus(0).split("-").map(Number);
  const index = year * 12 + (month - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};

const CASO1 = "Caso uno";
const CASO23 = "Casos dos y tres";
const EMPLEO = "Búsqueda activa";
const INGLES = "Inglés B1";
const ORDER = [GENERAL, CASO1, CASO23, EMPLEO, INGLES];

// The sections of the person's text that no part carries, and how many lines each holds. Two of them
// are tables, one mixes links with loose text: grouping by form would merge or split them.
const OUT_SECTIONS: { heading: string; lines: (i: number) => string; count: number }[] = [
  { heading: "Presupuesto de horas por mes", lines: (i) => `| Fila P${i} | ${i} h |`, count: 40 },
  { heading: "Fuentes", lines: (i) => (i % 2 ? `https://ejemplo.test/fuente-${i}` : `Lectura sugerida F${i}`), count: 13 },
  { heading: "Reglas del plan", lines: (i) => `Regla R${i}: una cosa a la vez`, count: 90 },
  { heading: "Calendario de entregas", lines: (i) => `| Entrega E${i} | semana ${i} |`, count: 160 },
  { heading: "Referencias", lines: (i) => `- Referencia X${i}`, count: 30 },
];
const OUT_TOTAL = OUT_SECTIONS.reduce((s, x) => s + x.count, 0);

type Built = { seed: Seed; corrections: { caso1: number; others: number } };

function longSeed(): Built {
  const lines: string[] = [];
  const headings: Src[] = [];
  const add = (text: string): Src => {
    lines.push(text);
    return { from: lines.length, to: lines.length };
  };
  const heading = (text: string) => headings.push(add(`## ${text}`));

  const generalSrc = [add(`# ${GENERAL}`)];
  const goalLines = (name: string) => [add(`# ${name}`)];

  function weeks(prefix: string, firstMonth: number, months: number, perMonth: number, children: number, ofCaso: string) {
    const tasks: RawTask[] = [];
    const monthRows: RawGoal["months"] = [];
    for (let m = 0; m < months; m++) {
      const month = monthAt(firstMonth + m);
      let sum = 0;
      for (let w = 1; w <= perMonth; w++) {
        const subs = Array.from({ length: children }, (_, c) => ({
          name: `Parte ${c + 1} de la semana ${m * perMonth + w} de ${ofCaso}`,
          estimate: 2,
          rule: null,
          noteSrc: [],
          noteText: null,
          src: [add(`  - 2 h · Parte ${c + 1} de ${prefix}${m * perMonth + w}`)],
        }));
        const estimate = children > 0 ? children * 2 : 3;
        sum += estimate;
        tasks.push(
          rawTask(`Semana ${m * perMonth + w} de ${ofCaso}`, {
            month,
            // A week with sub-tasks that also writes its own hours: one correction per week.
            estimate,
            src: [add(`- ${month} · Semana ${m * perMonth + w} de ${ofCaso}`)],
            children: subs,
          }),
        );
      }
      monthRows.push({ month, amount: sum, src: [add(`- ${month} · ${sum} h`)] });
    }
    return { tasks, monthRows };
  }

  const measure = { name: "horas", unit: "horas" };
  const commitment = (name: string) => ({
    name,
    cadenceKind: "daily" as const,
    cadenceWeekdays: null,
    cadenceN: null,
    satisfaction: "tap" as const,
    targetQuantity: null,
    unit: null,
    src: [add(`- ${name} · cada día`)],
  });

  heading("Caso uno");
  const c1 = weeks("c1-", 0, 3, 4, 5, CASO1);
  const c1Commitment = commitment("Cierre del mes");
  heading("Casos dos y tres");
  const c2 = weeks("c2-", 3, 3, 6, 0, CASO23);
  heading("Búsqueda activa");
  const c3 = weeks("c3-", 6, 3, 4, 0, EMPLEO);
  heading("Inglés");
  const c4 = weeks("c4-", 9, 2, 4, 0, INGLES);
  const ingles = [1, 2, 3, 4, 5].map((n) => commitment(`Hábito de inglés ${n}`));

  for (const section of OUT_SECTIONS) {
    heading(section.heading);
    for (let i = 1; i <= section.count; i++) add(section.lines(i));
  }

  const goals: RawGoal[] = [
    rawGoal(GENERAL, {
      key: "general",
      horizon: plus(500),
      src: [...generalSrc, ...headings],
      phases: [{ aim: "Portafolio base", startsOn: plus(10), endsOn: plus(120), src: [add("- Fase 1: portafolio base")] }],
    }),
    rawGoal(CASO1, { key: "c1", parent: "general", horizon: plus(400), measure, src: goalLines(CASO1), tasks: c1.tasks, months: c1.monthRows, commitments: [c1Commitment] }),
    rawGoal(CASO23, { key: "c23", parent: "general", horizon: plus(400), measure, src: goalLines(CASO23), tasks: c2.tasks, months: c2.monthRows }),
    rawGoal(EMPLEO, { key: "emp", parent: "general", horizon: plus(400), measure, src: goalLines(EMPLEO), tasks: c3.tasks, months: c3.monthRows }),
    rawGoal(INGLES, { key: "en", parent: "general", horizon: plus(400), measure, src: goalLines(INGLES), tasks: c4.tasks, months: c4.monthRows, commitments: ingles }),
  ];
  const raw: RawDraft = { goals };
  const seed: Seed = { raw, source: { kind: "lines", lines } };
  const made = stored(seed);
  const at = (c: { at: string }) => Number(c.at.split(".")[1]);
  return {
    seed,
    corrections: {
      caso1: made.corrections.filter((c) => at(c) === 1).length,
      others: made.corrections.filter((c) => at(c) !== 1).length + made.notices.length,
    },
  };
}

const box = (page: Page, name: string | RegExp) => page.getByRole("checkbox", { name });
const goalBox = (page: Page, name: string) => box(page, new RegExp(`^${name}`));
// The words a goal's row carries: its name and its summary line, inside the one label.
const goalRow = (page: Page, name: string) => goalBox(page, name).locator("xpath=ancestor::label[1]");
const parts = (page: Page) => page.getByRole("button", { name: /^Sus partes/ });
const monthFold = (page: Page, month: string) => page.getByRole("button", { name: new RegExp(`^${word(month)}`, "i") });
const taskBox = (page: Page, name: string) => box(page, new RegExp(`^${name}`));

async function open(button: Locator) {
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

test.describe("a long plan reads in one screen's worth of folds (902)", () => {
  test("the review of the long draft is under 3 000 px at 360", async ({ person, browser, baseURL }) => {
    // Kills: drawing every goal's tasks, months and out lines open, as the review does for any plan today (74 690 px).
    const { seed, corrections } = longSeed();
    expect(corrections.caso1, "the fixture must hold corrections in one goal").toBeGreaterThan(0);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      await expect(createButton(page)).toHaveText("Crear 5 metas");
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      expect(height).toBeLessThan(3000);
    });
  });

  test("each goal is one row with its tasks, commitments and months; the one with corrections says how many are left", async ({ person, browser, baseURL }) => {
    // Kills: a goal row with no summary, or a «por revisar» that counts all the corrections or none.
    const { seed, corrections } = longSeed();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      await expect(goalRow(page, CASO1)).toContainText(/12 tareas/);
      await expect(goalRow(page, CASO1)).toContainText(/1 compromiso\b/);
      await expect(goalRow(page, CASO1)).toContainText(/3 meses/);
      await expect(goalRow(page, CASO1)).toContainText(new RegExp(`\\b${corrections.caso1} por revisar`));
      await expect(goalRow(page, CASO23)).toContainText(/18 tareas/);
      await expect(goalRow(page, CASO23)).toContainText(/3 meses/);
      await expect(goalRow(page, EMPLEO)).toContainText(/12 tareas/);
      await expect(goalRow(page, INGLES)).toContainText(/8 tareas/);
      await expect(goalRow(page, INGLES)).toContainText(/5 compromisos/);
      await expect(goalRow(page, INGLES)).toContainText(/2 meses/);
      for (const name of [CASO23, EMPLEO, INGLES]) await expect(goalRow(page, name)).not.toContainText(/por revisar/);
    });
  });

  test("«Sus partes» opens a goal's months and a month opens its tasks", async ({ person, browser, baseURL }) => {
    // Kills: months or tasks drawn before their fold is pressed, or a fold that opens the wrong level.
    const { seed } = longSeed();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      const month = monthAt(3);
      await expect(taskBox(page, "Semana 1 de Casos dos y tres")).toBeHidden();
      await expect(monthFold(page, month)).toBeHidden();
      await parts(page).nth(2).click();
      await expect(monthFold(page, month)).toBeVisible();
      await expect(taskBox(page, "Semana 1 de Casos dos y tres")).toBeHidden();
      await monthFold(page, month).click();
      await expect(taskBox(page, "Semana 1 de Casos dos y tres")).toBeVisible();
      await expect(taskBox(page, "Semana 6 de Casos dos y tres")).toBeVisible();
      await expect(taskBox(page, "Semana 7 de Casos dos y tres")).toBeHidden();
    });
  });

  test("only the goal with corrections still to decide arrives open", async ({ person, browser, baseURL }) => {
    // Kills: every goal folded (the corrections are lost from view) or every goal open (the page is long again).
    const { seed, corrections } = longSeed();
    expect(corrections.others, "the fixture must hold corrections in one goal only").toBe(0);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      await expect(parts(page)).toHaveCount(5);
      const expanded = await parts(page).evaluateAll((all) => all.map((b) => b.getAttribute("aria-expanded")));
      expect(expanded).toEqual(["false", "true", "false", "false", "false"]);
      await expect(monthFold(page, monthAt(0))).toBeVisible();
    });
  });

  test("the goals under the general sit at their own level, indented, never folded inside the general", async ({ person, browser, baseURL }) => {
    // Kills: the child goals drawn inside the general's «Sus partes», or at the general's own edge.
    const { seed } = longSeed();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      const x = async (name: string) => (await boxOf(goalBox(page, name))).x;
      const g = await x(GENERAL);
      for (const name of [CASO1, CASO23, EMPLEO, INGLES]) {
        await expect(goalBox(page, name)).toBeVisible();
        expect(Math.abs((await x(name)) - (g + 16)), name).toBeLessThanOrEqual(1);
      }
      await expect(parts(page).first()).toHaveAttribute("aria-expanded", "false");
    });
  });
});

test.describe("«sin lugar en el plan» is grouped by the section of the person's text (902)", () => {
  test("one folded group per section heading, each with its count, and the counts add up to the line's out count", async ({ person, browser, baseURL }) => {
    // Kills: grouping by the line's form (the tables of two sections merge, the links of «Fuentes» split from its text), or a count that drops lines.
    const { seed } = longSeed();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      const line = await countOf(page);
      expect(line.out).toBe(OUT_TOTAL);
      let sum = 0;
      for (const section of OUT_SECTIONS) {
        const group = page.getByRole("button", { name: new RegExp(`^${section.heading}`) });
        await expect(group).toHaveCount(1);
        await expect(group).toHaveAttribute("aria-expanded", "false");
        const label = (await group.textContent())!;
        const shown = Number(label.slice(label.indexOf(section.heading) + section.heading.length).match(/\d+/)![0]);
        expect(shown, section.heading).toBe(section.count);
        sum += shown;
      }
      expect(sum).toBe(line.out);
      // Folded: no out line is drawn until its group opens.
      await expect(page.getByText("| Fila P1 |", { exact: false })).toBeHidden();
      await page.getByRole("button", { name: /^Presupuesto de horas por mes/ }).click();
      await expect(page.getByText("| Fila P1 |", { exact: false })).toBeVisible();
      await expect(page.getByText("| Entrega E1 |", { exact: false })).toBeHidden();
    });
  });
});

test.describe("what the review owed still holds when it is folded (902)", () => {
  test("unticking a whole goal from its folded row leaves it out of «Crear N metas», and the count line keeps its total", async ({ person, browser, baseURL }) => {
    // Kills: a folded goal whose checkbox does nothing, or one that takes a different count with it.
    const { seed } = longSeed();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      const before = await countOf(page);
      await expect(createButton(page)).toHaveText("Crear 5 metas");
      await expect(taskBox(page, "Semana 1 de Casos dos y tres")).toBeHidden();
      await goalBox(page, CASO23).uncheck();
      await expect(createButton(page)).toHaveText("Crear 4 metas");
      const after = await countOf(page);
      expect(after.total).toBe(before.total);
      expect(after.plan).toBeLessThan(before.plan);
      expect(after.out).toBeGreaterThan(before.out);
      await goalBox(page, CASO23).check();
      await expect(createButton(page)).toHaveText("Crear 5 metas");
    });
  });

  test("a correction inside a goal that was shut and opened again is still decidable, and the goal's count goes down", async ({ person, browser, baseURL }) => {
    // Kills: a fold that unmounts the corrections' state, or a «por revisar» that does not follow the decision.
    const { seed, corrections } = longSeed();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toSeededReview(page, seed);
      const first = parts(page).nth(1);
      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "false");
      await expect(monthFold(page, monthAt(0))).toBeHidden();
      await open(first);
      await open(monthFold(page, monthAt(0)));
      await page.getByRole("button", { name: "Dejar como estaba" }).first().click();
      await expect(page.getByText(/^Se queda (como decía el plan|fuera)/).first()).toBeVisible();
      await expect(goalRow(page, CASO1)).toContainText(new RegExp(`\\b${corrections.caso1 - 1} por revisar`));
    });
  });
});

test.describe("a short plan keeps reading as it did (902)", () => {
  test("the template's example: the goals' classes shown, its count line adding up", async ({ person, browser, baseURL }) => {
    // Guards: the long review's folds leaking into a plan that never needed them.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, movedExample());
      const names = await page.getByRole("checkbox", { name: /meta (general|grande|pequeña)/ }).count();
      expect(names).toBeGreaterThanOrEqual(2);
      await expect(createButton(page)).toHaveText(/^Crear \d+ metas$/);
      const line = await countOf(page);
      expect(line.plan + line.notes + line.out).toBe(line.total);
    });
  });

  test("the plan text of three levels: general, big and small goal stand 16 px a level apart and create three goals", async ({ person, browser, baseURL }) => {
    // Guards: the nesting the folds must keep (the same step as RP-89), on the existing short plan.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toReview(page, planText());
      const x = async (name: string) => (await boxOf(goalBox(page, name))).x;
      const g = await x(GENERAL);
      expect(Math.abs((await x(BIG)) - (g + 16))).toBeLessThanOrEqual(1);
      expect(Math.abs((await x(SMALL)) - (g + 32))).toBeLessThanOrEqual(1);
      await expect(createButton(page)).toHaveText("Crear 3 metas");
    });
  });
});
