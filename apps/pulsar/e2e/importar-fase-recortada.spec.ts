import type { Browser, Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";

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
      const note = page.locator("p").filter({ hasText: "La fase «" });
      await expect(note).toHaveCount(1);
      const today = dayAndMonth(todayInZone());
      await expect(note).toContainText(
        `La fase «${CUT}» empieza en la semana 1, el ${today}`,
      );
      await expect(note).toContainText(
        `La fase «${DROPPED}» termina antes de abrirla y no se crea.`,
      );
      // The dropped phase is no row; the cut one is.
      await expect(
        page.getByRole("checkbox", { name: new RegExp(DROPPED) }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("checkbox", { name: new RegExp(CUT) }),
      ).toBeVisible();
      // The line comes before the confirm.
      const noteBox = (await note.boundingBox())!;
      const confirm = (await page
        .getByRole("button", { name: "Crear 1 meta" })
        .boundingBox())!;
      expect(noteBox.y).toBeLessThan(confirm.y);
      // The span line opens on today.
      await expect(
        page.locator("p").filter({ hasText: `Desde el ${today} de ${todayInZone().slice(0, 4)} hasta el` }),
      ).toBeVisible();
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
        const card = (await page
          .getByRole("region", { name: "Fases recortadas" })
          .boundingBox())!;
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

  test("at 1440 with two goals the confirm bar spans both cards", async ({
    person,
    browser,
    baseURL,
  }) => {
    await review(
      { person, browser, baseURL },
      async (page) => {
        const first = (await page
          .getByRole("region", { name: "Fases recortadas" })
          .boundingBox())!;
        const second = (await page
          .getByRole("region", { name: "Segunda meta" })
          .boundingBox())!;
        const bar = (await page
          .getByRole("button", { name: "Crear 2 metas" })
          .evaluate((button) => {
            const box = button.parentElement!.getBoundingClientRect();
            return { x: box.x, width: box.width };
          }))!;
        const left = Math.min(first.x, second.x);
        const right = Math.max(first.x + first.width, second.x + second.width);
        expect(Math.abs(bar.x - left)).toBeLessThanOrEqual(1);
        expect(Math.abs(bar.x + bar.width - right)).toBeLessThanOrEqual(1);
      },
      1440,
      ["Fases recortadas", "Segunda meta"],
    );
  });

  test("with two goals each card names its own cut and drop notes, never the other goal's", async ({
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
        const first = page.getByRole("region", { name: "Fases recortadas" });
        const second = page.getByRole("region", { name: "Segunda meta" });
        await expect(first).toContainText(`La fase «${CUT}» empieza en la semana 1`);
        await expect(first).toContainText(`La fase «${DROPPED}» termina antes de abrirla`);
        await expect(second).toContainText("Fase tranquila");
        await expect(second).not.toContainText("La fase «");
        await expect(page.locator("p").filter({ hasText: "La fase «" })).toHaveCount(1);
      },
      1280,
      undefined,
      source,
    );
  });
});
