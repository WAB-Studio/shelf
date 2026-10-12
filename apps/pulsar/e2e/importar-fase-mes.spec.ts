import type { Page } from "@playwright/test";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";

// A proposed phase inside one month reads one month; one that crosses a year
// names both years (RP-37). The board is `ImportarRevisar`.

const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const day = (date: string) => `${Number(date.slice(8, 10))} ${ABBR[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const span = (from: string, to: string) => `fase · ${day(from)} – ${day(to)}`;

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
  test("a phase inside one month reads its two days, with the year", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await review(page, plan("2026-11-02 a 2026-11-29"));
      const row = page.getByRole("checkbox", { name: /Evals y harness/ });
      await expect(row).toBeVisible();
      await expect(page.getByText(span("2026-11-02", "2026-11-29"), { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a phase that crosses a year names the year on both days", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await review(page, plan("2026-12-01 a 2027-02-28"));
      await expect(page.getByRole("checkbox", { name: /Evals y harness/ })).toBeVisible();
      await expect(page.getByText(span("2026-12-01", "2027-02-28"), { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("a phase from one month to the same month a year on names the year on both days", async ({ person, browser, baseURL }) => {
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await review(page, plan("2026-11-02 a 2027-11-28", "2028-01-01"));
      await expect(page.getByRole("checkbox", { name: /Evals y harness/ })).toBeVisible();
      await expect(page.getByText(span("2026-11-02", "2027-11-28"), { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
