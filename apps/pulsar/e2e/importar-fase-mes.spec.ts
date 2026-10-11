import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { civilDateToDate } from "../lib/zone";

// A proposed phase inside one month reads one month; one that crosses a year
// names both years (RP-37). The board is `ImportarRevisar`.

const short = (date: string, withYear: boolean) =>
  new Intl.DateTimeFormat("es", withYear ? { month: "short", year: "numeric", timeZone: "UTC" } : { month: "short", timeZone: "UTC" })
    .format(civilDateToDate(date))
    .replace(".", "");

const plan = (phase: string, horizon = "2027-10-01") =>
  `pulsar · plantilla 1\n\n# Fases\nhorizonte: ${horizon}\nmedida: horas de estudio · minutos\n\n## Fases\n- ${phase} · Evals y harness\n\n## Meses\n- 2026-11 · 12 h`;

async function review(page: Page, text: string) {
  await page.goto("/metas/importar");
  await page.getByLabel(messages.textLabel).fill(text);
  await page.getByRole("button", { name: "Leer el plan" }).click();
  await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
  await expect(page.getByRole("heading", { name: messages.review.title })).toBeVisible();
}

test.describe("the review's phase span (RP-37)", () => {
  test("a phase inside one month reads that month alone", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await review(page, plan("2026-11-02 a 2026-11-29"));
      const row = page.getByRole("checkbox", { name: /Evals y harness/ });
      await expect(row).toBeVisible();
      const label = short("2026-11-02", true);
      await expect(page.getByText(label, { exact: true })).toBeVisible();
      await expect(page.getByText(`${label}–${label}`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a phase that crosses a year names both years", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await review(page, plan("2026-12-01 a 2027-02-28"));
      await expect(page.getByRole("checkbox", { name: /Evals y harness/ })).toBeVisible();
      await expect(page.getByText(`${short("2026-12-01", true)}–${short("2027-02-28", true)}`, { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a phase from one month to the same month a year on names both years", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await review(page, plan("2026-11-02 a 2027-11-28", "2028-01-01"));
      await expect(page.getByRole("checkbox", { name: /Evals y harness/ })).toBeVisible();
      await expect(page.getByText(`${short("2026-11-02", true)}–${short("2027-11-28", true)}`, { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
