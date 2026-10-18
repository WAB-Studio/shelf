import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// Module 61 (Q19 a): under «Copia», while the browser has not kept the log and the API
// exists, one line says why and «Pedirlo» asks. Written from the board (WordBook canvas,
// page «Cuenta», 2026-10-18), not from the component. Signed out; no address is ever typed
// into /cuenta.

const LINE = "El navegador puede borrar tu registro si te falta espacio.";
const ASK = "Pedirlo";
const ASKING = "Pidiéndolo…";
const REFUSED = "El navegador no lo permitió; instala WordBook en tu pantalla de inicio para que lo guarde.";

type Stub = "no-api" | "not-kept" | "kept";

declare global {
  interface Window {
    __persistCalls: number;
    __answerPersist: (granted: boolean) => void;
  }
}

// `persist()` stays open until the test answers, so the pending state can be looked at.
async function stubStorage(page: Page, stub: Stub): Promise<void> {
  await page.addInitScript((mode) => {
    window.__persistCalls = 0;
    let answer: (granted: boolean) => void = () => {};
    window.__answerPersist = (granted) => answer(granted);
    if (mode === "no-api") {
      Object.defineProperty(navigator, "storage", { value: undefined, configurable: true });
      return;
    }
    const kept = { value: mode === "kept" };
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: () => Promise.resolve(kept.value),
        persist: () => {
          window.__persistCalls += 1;
          return new Promise<boolean>((resolve) => {
            answer = (granted) => {
              kept.value = granted;
              resolve(granted);
            };
          });
        },
      },
    });
  }, stub);
}

async function open(page: Page, stub: Stub): Promise<void> {
  await stubStorage(page, stub);
  await page.goto("/cuenta");
  await expect(page.getByText("Copia", { exact: true }).first()).toBeVisible();
}

async function noOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBe(clientWidth);
}

for (const width of [360, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
    });

    test("not kept: the line and «Pedirlo» sit under «Copia», and nothing is asked yet", async ({ page }) => {
      await open(page, "not-kept");
      const line = page.getByText(LINE);
      const ask = page.getByRole("button", { name: ASK, exact: true });
      await expect(line).toBeVisible();
      await expect(ask).toBeVisible();
      await expect(ask).toBeEnabled();
      const label = await page.getByText("Copia", { exact: true }).first().boundingBox();
      const lineBox = await line.boundingBox();
      expect(lineBox!.y).toBeGreaterThan(label!.y);
      expect(await page.evaluate(() => window.__persistCalls)).toBe(0);
      await noOverflow(page);
    });

    test("asking: one tap calls persist once, the button reads «Pidiéndolo…» and is disabled until it answers", async ({
      page,
    }) => {
      await open(page, "not-kept");
      await page.getByRole("button", { name: ASK, exact: true }).click();
      const asking = page.getByRole("button", { name: ASKING, exact: true });
      await expect(asking).toBeVisible();
      await expect(asking).toBeDisabled();
      await expect(page.getByRole("button", { name: ASK, exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => window.__persistCalls)).toBe(1);
      await noOverflow(page);
    });

    test("granted: the line and the button go", async ({ page }) => {
      await open(page, "not-kept");
      await page.getByRole("button", { name: ASK, exact: true }).click();
      await expect(page.getByRole("button", { name: ASKING, exact: true })).toBeDisabled();
      await page.evaluate(() => window.__answerPersist(true));
      await expect(page.getByText(LINE)).toHaveCount(0);
      await expect(page.getByRole("button", { name: ASK, exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: ASKING, exact: true })).toHaveCount(0);
    });

    test("refused: the line stays and «Pedirlo» comes back enabled", async ({ page }) => {
      await open(page, "not-kept");
      await page.getByRole("button", { name: ASK, exact: true }).click();
      await expect(page.getByRole("button", { name: ASKING, exact: true })).toBeDisabled();
      await page.evaluate(() => window.__answerPersist(false));
      await expect(page.getByText(LINE)).toBeVisible();
      const ask = page.getByRole("button", { name: ASK, exact: true });
      await expect(ask).toBeVisible();
      await expect(ask).toBeEnabled();
      await expect(page.getByRole("button", { name: ASKING, exact: true })).toHaveCount(0);
      const status = page.getByRole("status").filter({ hasText: REFUSED });
      await expect(status).toBeVisible();
      const askBox = await ask.boundingBox();
      expect((await status.boundingBox())!.y).toBeGreaterThan(askBox!.y);
      await noOverflow(page);
    });

    test("refused, asked again: the status line stays, and a grant then hides the block", async ({ page }) => {
      await open(page, "not-kept");
      await page.getByRole("button", { name: ASK, exact: true }).click();
      await page.evaluate(() => window.__answerPersist(false));
      await expect(page.getByText(REFUSED)).toBeVisible();
      await page.getByRole("button", { name: ASK, exact: true }).click();
      expect(await page.evaluate(() => window.__persistCalls)).toBe(2);
      await expect(page.getByRole("button", { name: ASKING, exact: true })).toBeDisabled();
      await page.evaluate(() => window.__answerPersist(false));
      await expect(page.getByText(REFUSED)).toBeVisible();
      await page.getByRole("button", { name: ASK, exact: true }).click();
      await page.evaluate(() => window.__answerPersist(true));
      await expect(page.getByText(REFUSED)).toHaveCount(0);
      await expect(page.getByText(LINE)).toHaveCount(0);
    });

    test("not kept, never asked: no refusal line", async ({ page }) => {
      await open(page, "not-kept");
      await expect(page.getByText(REFUSED)).toHaveCount(0);
    });

    test("kept: nothing is drawn and nothing is asked", async ({ page }) => {
      await open(page, "kept");
      // Give the async read time to land before asserting an absence.
      await page.waitForTimeout(500);
      await expect(page.getByText(LINE)).toHaveCount(0);
      await expect(page.getByRole("button", { name: ASK, exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => window.__persistCalls)).toBe(0);
    });

    test("no API: nothing is drawn", async ({ page }) => {
      await open(page, "no-api");
      await page.waitForTimeout(500);
      await expect(page.getByText(LINE)).toHaveCount(0);
      await expect(page.getByRole("button", { name: ASK, exact: true })).toHaveCount(0);
      await noOverflow(page);
    });
  });
}
