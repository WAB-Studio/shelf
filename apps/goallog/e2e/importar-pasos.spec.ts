import messages from "../messages/es/import.json";
import { readWorkbook } from "../lib/import/workbook";
import { appAlerts, test, expect } from "./fixtures";
import {
  asPerson,
  planText,
  readWithTemplate,
  stepsEverDrawn,
  stepsSeen,
  streamInPlaceOfModel,
  watchSteps,
} from "./importar-plan";

// The entry of /metas/importar: what it hands the person (the template, the workbook, the text for
// another AI) and the three steps a model read goes through (RP-86, RP-98). The boards are
// `ImportarEntrada` and `ImportarPasos`. No spec here calls a model: a read that would is a
// stream the page is given in place of the server's.

const PROSE = "Octubre: leer el capítulo uno. Noviembre: el dos.";

test.describe("the entry hands over the template, the workbook and the text for another AI (RP-86, RP-98)", () => {
  test("«copiar la plantilla» copies plantilla 2 and «copiar el texto» copies the instruction that holds it", async ({ person, browser, baseURL }) => {
    // Kills: copying the v1 example for the template, or the bare template for the instruction.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await page.getByRole("button", { name: messages.template.copy }).click();
      await expect(page.getByRole("button", { name: messages.template.copied })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(messages.template.example);
      expect(messages.template.example.startsWith("goallog · plantilla 2")).toBe(true);

      await expect(page.getByRole("button", { name: messages.entry.copyInstruction })).toBeVisible();
      await page.getByRole("button", { name: messages.entry.copyInstruction }).click();
      await expect(page.getByRole("button", { name: messages.entry.instructionCopied })).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(messages.entry.instruction);
      expect(copied).toContain(messages.template.example);
      expect(copied).toContain("[pega aquí tu plan]");
    });
  });

  test("the empty entry shows «la plantilla» and «para otra IA» with their words, and the privacy line", async ({ person, browser, baseURL }) => {
    // Kills: dropping the «para otra IA» section, or the privacy line above «Leer el plan».
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await expect(page.getByText(messages.template.note, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.entry.otherAiLabel, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.entry.otherAiNote, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.uploadHint, { exact: true })).toBeVisible();
      const privacy = page.getByText(messages.privacy, { exact: true });
      await expect(privacy).toBeVisible();
      const [line, button] = [await privacy.boundingBox(), await page.getByRole("button", { name: messages.read }).boundingBox()];
      expect(line!.y + line!.height).toBeLessThanOrEqual(button!.y + 1);
      // Both code blocks are on the page: the template and the instruction that carries it.
      await expect(page.getByText("goallog · plantilla 2").first()).toBeVisible();
      await expect(page.getByText("[pega aquí tu plan]")).toBeVisible();
    });
  });

  test("«Descargar la plantilla en Excel» downloads plantilla-goallog.xlsx, a book the reader takes for the template", async ({ person, browser, baseURL }) => {
    // Kills: a link to a path the server does not serve, or a book with no rows.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      await expect(page.getByRole("link", { name: messages.entry.workbook })).toBeVisible();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("link", { name: messages.entry.workbook }).click(),
      ]);
      expect(download.suggestedFilename()).toBe("plantilla-goallog.xlsx");
      const path = await download.path();
      const { readFile } = await import("node:fs/promises");
      const read = await readWorkbook(new Uint8Array(await readFile(path)));
      expect(read.matched).toBe(true);
      expect("draft" in read && read.draft.goals.length).toBeGreaterThanOrEqual(3);
    });
  });
});

test.describe("a model read says its three steps (RP-86, RNP-13)", () => {
  test("«Encuentra», then «Acomoda», then «Revisa» are marked in progress in that order, then the review opens", async ({ person, browser, baseURL }) => {
    // Kills: opening the review without drawing the steps, or marking «Revisa» before «Acomoda».
    await asPerson({ person, browser, baseURL }, async (page) => {
      await watchSteps(page);
      const done = await readWithTemplate(page, planText());
      await streamInPlaceOfModel(page, { done: { ...done, via: "model" } });
      await page.goto("/metas/importar");
      await expect(page.getByText(messages.steps.find.name)).toHaveCount(0);

      await page.getByLabel(messages.textLabel, { exact: true }).fill(PROSE);
      await page.getByRole("button", { name: messages.read }).click();

      // Sent: the text is dimmed and shut, the reading says it is slow, the privacy line stays.
      await expect(page.getByRole("button", { name: messages.reading })).toBeDisabled();
      await expect(page.getByLabel(messages.textLabel, { exact: true })).toBeDisabled();
      await expect(page.getByLabel(messages.upload)).toBeDisabled();
      await expect(page.getByText(messages.slow, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.privacy, { exact: true })).toBeVisible();
      for (const step of [messages.steps.find, messages.steps.arrange, messages.steps.check]) {
        await expect(page.getByRole("listitem").filter({ hasText: step.name }).filter({ hasText: step.hint })).toBeVisible();
      }

      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      // declared = filled, partial = half, empty = outline (the marks' own states).
      expect((await stepsSeen(page)).filter((s) => s !== "empty|empty|empty")).toEqual(["partial|empty|empty", "declared|partial|empty", "declared|declared|partial"]);
    });
  });

  test("a template read draws no steps: no model is asked", async ({ person, browser, baseURL }) => {
    // Kills: drawing the three steps for every read.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await watchSteps(page);
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel, { exact: true }).fill(planText());
      await page.getByRole("button", { name: messages.read }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      expect(await stepsSeen(page)).toEqual([]);
      expect(await stepsEverDrawn(page)).toBe(false);
    });
  });

  test("a stream that ends in an error shows that error, drops the steps and keeps the text", async ({ person, browser, baseURL }) => {
    // Kills: reading any failed stream as «modelFailed», or leaving the steps standing.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await streamInPlaceOfModel(page, { error: "import.errors.empty" }, 400);
      await page.goto("/metas/importar");
      const box = page.getByLabel(messages.textLabel, { exact: true });
      await box.fill(PROSE);
      await page.getByRole("button", { name: messages.read }).click();

      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(messages.errors.empty);
      await expect(box).toHaveValue(PROSE);
      await expect(box).toBeEnabled();
      await expect(page.getByText(messages.steps.find.hint, { exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/metas\/importar$/);
    });
  });
});
