import { readFileSync } from "node:fs";

import type postgres from "postgres";

import messages from "../messages/es/import.json";
import { WORKBOOK_NAME } from "../lib/import/workbook";
import { test, expect } from "./fixtures";
import { asPerson } from "./importar-plan";

// Module 1004 (RP-98): the template book by its link on /metas/importar and by its URL. The handler is proven in-process by
// scripts/plan/import-route.ts; nobody downloaded it through the screen or the route until here.

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function rowsOf(db: postgres.Sql, id: string) {
  const [goals] = await db`select count(*)::int as n from goals.goals where user_id = ${id}`;
  const [calls] = await db`select count(*)::int as n from goals.model_calls where user_id = ${id}`;
  return { goals: goals.n, calls: calls.n };
}

for (const [width, height] of [[360, 740], [1280, 800]] as const)
  test(`at ${width}: the template link downloads ${WORKBOOK_NAME}, and that file goes back in with its 4 goals and no model`, async ({ person, browser, baseURL, db }) => {
    // Kills: `download` removed from the link (the attribute is the screen's own promise of a file; the route's attachment header alone would still
    // save it, so the download event cannot see this one); a workbook the importer cannot read back.
    await asPerson({ person, browser, baseURL }, async (page) => {
      await page.goto("/metas/importar");
      const link = page.getByRole("link", { name: messages.entry.workbook }).filter({ visible: true }).first();
      await expect(link).toBeVisible();
      await expect(link, "the link asks for a download").toHaveAttribute("download", "");
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      expect(download.suggestedFilename()).toBe(WORKBOOK_NAME);
      const path = await download.path();
      expect(path, "the browser saved the file").toBeTruthy();

      await page.getByLabel(messages.upload).setInputFiles({ name: download.suggestedFilename(), mimeType: XLSX, buffer: readFileSync(path) });
      await page.getByRole("button", { name: messages.read }).click();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      await expect(page.getByRole("button", { name: "Crear 4 metas" })).toBeVisible();
    }, { width, height });
    expect(await rowsOf(db, person.id), "nothing stored: the download and the reading are free").toEqual({ goals: 0, calls: 0 });
  });

test("the template URL serves the same book with no session, and writes nothing", async ({ person, playwright, baseURL, db }) => {
  // Kills: `getPerson()` and a 401 in the route; a missing `no-store` or attachment.
  const before = await rowsOf(db, person.id);
  const anonymous = await playwright.request.newContext({ baseURL: baseURL!, storageState: { cookies: [], origins: [] } });
  try {
    const response = await anonymous.get("/importar/plantilla.xlsx");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe(XLSX);
    expect(response.headers()["content-disposition"]).toBe(`attachment; filename=${WORKBOOK_NAME}`);
    expect(response.headers()["cache-control"]).toBe("no-store");
    const body = await response.body();
    expect(body.subarray(0, 2).toString(), "a zip").toBe("PK");
  } finally {
    await anonymous.dispose();
  }
  expect(await rowsOf(db, person.id)).toEqual(before);
});
