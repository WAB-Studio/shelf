import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { asPerson, createButton, planText, readWithTemplate, streamInPlaceOfModel, unfold } from "./importar-plan";

// A section the model could not read is said above the first goal, one muted line each, in the
// text's order; it counts no goal and never blocks «Crear» (RP-90, RP-86). The board is
// `ImportarSeccionFuera`; the words are the ones written in docs/goallog/DESIGN.md. The model is
// never reached: the page is handed the answer `/importar/leer` would give.

const PROSE = "Octubre: leer el capítulo uno. Noviembre: el dos.";
type Out = { heading: string; from: number; to: number };
const line = ({ heading, from, to }: Out) =>
  `No se pudo leer la sección «${heading}» (líneas ${from} a ${to}): quedó fuera. Pégala sola para importarla.`;
const SECTIONS = /No se pudo leer la sección/;

// `json` answers as the route does for a plain read, `stream` as it does for a model read.
async function review(page: Page, leftOut: Out[] | undefined, mode: "json" | "stream") {
  const done = { ...(await readWithTemplate(page, planText({ rhythm: false }))), via: "model", ...(leftOut ? { leftOut } : {}) };
  if (mode === "stream") await streamInPlaceOfModel(page, { done }, 50);
  else {
    await page.route("**/importar/leer", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(done) }) : route.continue(),
    );
  }
  await page.goto("/metas/importar");
  await page.getByLabel(messages.textLabel, { exact: true }).fill(PROSE);
  await page.getByRole("button", { name: messages.read }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
  await unfold(page);
}

const ONE: Out = { heading: "Semana 3", from: 40, to: 58 };
const THREE: Out[] = [ONE, { heading: "Presupuesto", from: 61, to: 75 }, { heading: "Anexos", from: 90, to: 120 }];

test.describe("a section the model could not read is said above the goals (RP-90, RP-86)", () => {
  for (const mode of ["json", "stream"] as const) {
    test(`none left out (${mode}): no line`, async ({ person, browser, baseURL }) => {
      // Kills: drawing a line, or an empty one, for `leftOut: []`.
      await asPerson({ person, browser, baseURL }, async (page) => {
        await review(page, [], mode);
        await expect(page.getByText(SECTIONS)).toHaveCount(0);
        await expect(page.getByText(/quedó fuera/)).toHaveCount(0);
        await expect(createButton(page)).toHaveText("Crear 3 metas");
      });
    });

    test(`one left out (${mode}): the line names its heading and lines, above the first goal, muted`, async ({ person, browser, baseURL }) => {
      // Kills: not reading `leftOut` from the answer, or dropping the heading or the range from the words.
      await asPerson({ person, browser, baseURL }, async (page) => {
        await review(page, [ONE], mode);
        const lines = page.getByText(SECTIONS);
        await expect(lines).toHaveCount(1);
        await expect(lines).toHaveText(line(ONE));

        const first = await page.getByRole("checkbox").first().boundingBox();
        const said = await lines.boundingBox();
        expect(said!.y + said!.height).toBeLessThanOrEqual(first!.y);

        // Muted: not the ink the goals' names are drawn in.
        const color = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => getComputedStyle(el).color);
        const ink = await color(page.getByRole("heading", { name: messages.review.title }));
        expect(await color(lines)).not.toBe(ink);
      });
    });
  }

  test("three left out: three lines, one each, in the text's order, above the first goal", async ({ person, browser, baseURL }) => {
    // Kills: drawing only the first, reordering them, or merging them into one line.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await review(page, THREE, "stream");
      const lines = page.getByText(SECTIONS);
      await expect(lines).toHaveCount(3);
      await expect(lines).toHaveText(THREE.map(line));

      const first = await page.getByRole("checkbox").first().boundingBox();
      const last = await lines.nth(2).boundingBox();
      expect(last!.y + last!.height).toBeLessThanOrEqual(first!.y);
    });
  });

  test("the lines count no goal, are not markable and «Crear» still creates the goals that were read", async ({ person, browser, baseURL, db }) => {
    // Kills: counting a line as a goal, giving it a checkbox, or blocking «Crear» while a section is out.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await review(page, THREE, "stream");
      await expect(page.getByText(SECTIONS)).toHaveCount(3);
      await expect(page.getByRole("checkbox", { name: SECTIONS })).toHaveCount(0);
      await expect(createButton(page)).toHaveText("Crear 3 metas");
      await expect(createButton(page)).toBeEnabled();

      await createButton(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      const goals = await db`select 1 from goals.goals where user_id = ${person.id}`;
      expect(goals).toHaveLength(3);
    });
  });
});
