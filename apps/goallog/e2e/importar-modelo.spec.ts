import { appAlerts, test, expect } from "./fixtures";
import messages from "../messages/es/import.json";

// Against `PULSAR_FAULT_BASE_URL`: a `next start` of the same build with
// `PULSAR_MODEL_STUB=draft:e2e/data/modelo-borrador.json`, so the model answers
// a fixed draft and no run ever spends (RNP-13).
//
// The `fail` seam is a per-server setting, never a per-request one, so the case
// that needs it runs against `PULSAR_MODEL_FAIL_BASE_URL`, a server started
// with `PULSAR_MODEL_STUB=fail`. CI does not start that fourth server: there the
// case is listed, not driven.
const FAIL_BASE_URL = process.env.PULSAR_MODEL_FAIL_BASE_URL;

const PROSE = "Octubre: leer el capítulo uno. Noviembre: el dos.";

test.describe("the import screen against a stubbed model (RP-37, RNP-13)", () => {
  test("a pasted text lands on the review and writes one settled claim", async ({ person, browser, baseURL, db }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill(PROSE);
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

      const rows = await db<{ source: string; outcome: string | null }[]>`
        select source, outcome from goals.model_calls where user_id = ${person.id}
      `;
      expect(rows).toEqual([{ source: "paste", outcome: "ok" }]);
    } finally {
      await context.close();
    }
  });

  test("a model draft whose days come out of order is reviewed Monday first with «y» before the last", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill(PROSE);
      await page.getByRole("button", { name: "Leer el plan" }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);

      await expect(page.getByRole("checkbox", { name: /Tema técnico/ })).toHaveAccessibleName(/Tema técnico.*lunes, miércoles y domingo/);
    } finally {
      await context.close();
    }
  });

  test("with ten reads today the cap notice shows, the upload is shut and nothing more is claimed", async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    for (let i = 0; i < 10; i += 1) {
      await db`
        insert into goals.model_calls (user_id, model, source, outcome)
        values (${person.id}, 'gpt-5-mini', 'paste', 'ok')
      `;
    }
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      await page.getByLabel(messages.textLabel).fill(PROSE);
      await page.getByRole("button", { name: "Leer el plan" }).click();

      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(messages.errors.cap);
      await expect(page.getByLabel(messages.upload)).toBeDisabled();
      await expect(page.getByLabel(messages.textLabel)).toHaveValue(PROSE);
      await expect(page.getByRole("button", { name: "ver la plantilla" })).toBeVisible();

      const [{ count }] = await db<{ count: string }[]>`
        select count(*) from goals.model_calls where user_id = ${person.id}
      `;
      expect(Number(count)).toBe(10);
    } finally {
      await context.close();
    }
  });

  test("a model that fails shows the failure with the text kept and offers another try", async ({
    person,
    browser,
  }) => {
    test.skip(!FAIL_BASE_URL, "needs a server started with PULSAR_MODEL_STUB=fail (PULSAR_MODEL_FAIL_BASE_URL)");
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: FAIL_BASE_URL! });
    try {
      const page = await context.newPage();
      await page.goto("/metas/importar");
      const area = page.getByLabel(messages.textLabel);
      await area.fill(PROSE);
      await page.getByRole("button", { name: "Leer el plan" }).click();

      await expect(appAlerts(page).filter({ hasText: /\S/ })).toHaveText(messages.errors.modelFailed);
      await expect(area).toHaveValue(PROSE);
      await expect(page.getByRole("button", { name: "Intentar otra vez" })).toBeVisible();
      await expect(page.getByRole("button", { name: "ver la plantilla" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
