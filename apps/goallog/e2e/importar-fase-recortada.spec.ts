import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { unfold } from "./importar-plan";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";
import { boxOf } from "./box";

// The review says what the import does to a phase that starts before the goal
// opens (cut to today) or ends before it (not created), and its confirm bar
// stands one card wide at 1440 (RP-37). The board is `ImportarFaseRecortada`.

const plus = (days: number) => {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
};
const dayAndMonth = (date: string) =>
  new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(civilDateToDate(date));

const CUT = "Diagnóstico";
const DROPPED = "Repaso de verano";

const goalBlock = (title: string) =>
  [
    `# ${title}`,
    `horizonte: ${plus(200)}`,
    "medida: horas de estudio · minutos",
    "",
    "## Fases",
    `- ${plus(-90)} a ${plus(-60)} · ${DROPPED}`,
    `- ${plus(-10)} a ${plus(20)} · ${CUT}`,
    "",
    "## Meses",
    `- ${todayInZone().slice(0, 7)} · 12 h`,
  ].join("\n");

const plan = (titles = ["Fases recortadas"]) =>
  ["pulsar · plantilla 1", "", titles.map(goalBlock).join("\n\n")].join("\n");

type Fixtures = {
  person: { id: string; sessionFile: string };
  browser: Browser;
  baseURL: string | undefined;
};
async function review(
  { person, browser, baseURL }: Fixtures,
  run: (page: Page) => Promise<void>,
  width = 1280,
  titles?: string[],
  source?: string,
) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/metas/importar");
    await page.getByLabel(messages.textLabel).fill(source ?? plan(titles));
    await page.getByRole("button", { name: "Leer el plan" }).click();
    await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
    await expect(
      page.getByRole("heading", { name: messages.review.title }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Sus partes/ }).first()).toBeVisible();
    await unfold(page);
    await run(page);
  } finally {
    await context.close();
  }
}

test.describe("the review says the cut (RP-37)", () => {
  test("a phase starting before today is named with week 1 and today; one ending before it is not created", async ({
    person,
    browser,
    baseURL,
  }) => {
    await review({ person, browser, baseURL }, async (page) => {
      // The cut hangs under its phase, the drop under its goal.
      const notes = page.locator("p").filter({ hasText: "La fase «" });
      await expect(notes).toHaveCount(2);
      const today = dayAndMonth(todayInZone());
      const cut = notes.filter({ hasText: `La fase «${CUT}» empieza en la semana 1, el ${today}` });
      const drop = notes.filter({ hasText: `La fase «${DROPPED}» termina antes de abrirla y no se crea.` });
      await expect(cut).toHaveCount(1);
      await expect(drop).toHaveCount(1);
      // The dropped phase is no row; the cut one is.
      await expect(
        page.getByRole("checkbox", { name: new RegExp(DROPPED) }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("checkbox", { name: new RegExp(CUT) }),
      ).toBeVisible();
      // The line comes before the confirm.
      const noteBox = (await boxOf(drop));
      const confirm = (await boxOf(page
        .getByRole("button", { name: "Crear 1 meta" })));
      expect(noteBox.y).toBeLessThan(confirm.y);
    });
  });

  test("at 1440 with one goal the card and the confirm bar stand one width", async ({
    person,
    browser,
    baseURL,
  }) => {
    await review(
      { person, browser, baseURL },
      async (page) => {
        const card = (await boxOf(page
          .getByRole("region", { name: messages.review.title })));
        const bar = await page
          .getByRole("button", { name: "Crear 1 meta" })
          .evaluate(
            (button) => button.parentElement!.getBoundingClientRect().width,
          );
        expect(Math.abs(card.width - bar)).toBeLessThanOrEqual(1);
      },
      1440,
    );
  });

  test("at 1440 with two goals the tree is still one card and the confirm bar stands its width", async ({
    person,
    browser,
    baseURL,
  }) => {
    await review(
      { person, browser, baseURL },
      async (page) => {
        await expect(page.getByRole("region", { name: messages.review.title })).toHaveCount(1);
        const card = (await boxOf(page.getByRole("region", { name: messages.review.title })));
        const bar = (await page
          .getByRole("button", { name: "Crear 2 metas" })
          .evaluate((button) => {
            const box = button.parentElement!.getBoundingClientRect();
            return { x: box.x, width: box.width };
          }))!;
        expect(Math.abs(bar.x - card.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(bar.width - card.width)).toBeLessThanOrEqual(1);
      },
      1440,
      ["Fases recortadas", "Segunda meta"],
    );
  });

  test("with two goals the cut and drop notes name only the goal that has them, never the other's phase", async ({
    person,
    browser,
    baseURL,
  }) => {
    const calm = [
      "# Segunda meta",
      `horizonte: ${plus(200)}`,
      "medida: horas de estudio · minutos",
      "",
      "## Fases",
      `- ${plus(5)} a ${plus(40)} · Fase tranquila`,
      "",
      "## Meses",
      `- ${todayInZone().slice(0, 7)} · 12 h`,
    ].join("\n");
    const source = ["pulsar · plantilla 1", "", goalBlock("Fases recortadas"), "", calm].join("\n");
    await review(
      { person, browser, baseURL },
      async (page) => {
        await expect(page.getByRole("checkbox", { name: /^Fase tranquila/ })).toBeVisible();
        const notes = page.locator("p").filter({ hasText: "La fase «" });
        await expect(notes).toHaveCount(2);
        await expect(notes.filter({ hasText: CUT })).toHaveCount(1);
        await expect(notes.filter({ hasText: DROPPED })).toHaveCount(1);
        await expect(notes.filter({ hasText: "Fase tranquila" })).toHaveCount(0);
      },
      1280,
      undefined,
      source,
    );
  });
});
