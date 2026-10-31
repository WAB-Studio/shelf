import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// The findings of the deploy critic of 2026-10-31 that needed no decision: each one measured on the screen.

async function open(page: Page, route: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
  const asset =
    route === "/"
      ? page.waitForResponse((response) => response.url().includes(manifest.asset.path) && response.ok())
      : null;
  await page.goto(route);
  if (asset !== null) {
    await asset;
    await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
  }
}

function box(page: Page) {
  return page.getByRole("textbox", { name: messages.search.label });
}

// Looks each word up and leaves the box empty, so the lookup is written to the record.
async function lookUp(page: Page, words: string[]): Promise<void> {
  for (const word of words) {
    await box(page).fill(word);
    await expect(page.getByRole("heading", { name: word })).toBeVisible();
    await box(page).fill("");
  }
}

test("a rare-labelled sense of the most frequent part of speech stays: blind shows «ciego» with no fold, index first", async ({
  page,
}) => {
  await open(page, "/", 390);
  await box(page).fill("blind");
  const index = page.locator("main [data-entry-index]").first();
  await expect(index).toContainText(new RegExp(`^[^]*${messages.word.pos.adj}[^]*${messages.word.pos.v}`, "i"));
  await expect(page.getByText("ciego", { exact: false }).first()).toBeVisible();
});

test("a rare sense of a less frequent part of speech still folds: bleak's river fish", async ({ page }) => {
  await open(page, "/", 390);
  await box(page).fill("bleak");
  await expect(page.getByRole("heading", { name: "bleak" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ver \d+ sentidos? poco usados?$/ })).toBeVisible();
});

test("at 1280 the box keeps its width from an empty box to a phrase, and the panels do not move", async ({ page }) => {
  await page.route("**/api/translate", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "Se me acaba el tiempo y más", origin: "network" }) }),
  );
  await open(page, "/", 1280);
  const panels = page.locator("main > div").first();
  const before = await panels.boundingBox();
  await box(page).fill("time");
  await expect(page.getByRole("heading", { name: "time" })).toBeVisible();
  const word = await box(page).boundingBox();
  await box(page).fill("I'm running out of time and more");
  await expect(page.getByText("Se me acaba el tiempo y más")).toBeVisible();
  const phrase = await box(page).boundingBox();
  const after = await panels.boundingBox();
  expect(Math.abs(phrase!.width - word!.width)).toBeLessThan(2);
  expect(after!.x).toBe(before!.x);
  expect(after!.width).toBe(before!.width);
});

test("at 1280 the screens share one left edge and /cuenta is two panels", async ({ page }) => {
  await open(page, "/registro", 1280);
  const edges: number[] = [];
  for (const route of ["/registro", "/repaso", "/cuenta"]) {
    await page.goto(route);
    edges.push(Math.round((await page.getByRole("heading", { level: 1 }).boundingBox())!.x));
  }
  expect(new Set(edges).size).toBe(1);
  const side = page.locator("main aside");
  await expect(side).toContainText(messages.account.info.dictionaryName);
  const main = (await page.locator("main > div").first().boundingBox())!;
  const aside = (await side.boundingBox())!;
  expect(aside.x).toBeGreaterThan(main.x + main.width / 2);
});

test("a /registro row is one compact line, and the story and the row count the same searches", async ({ page }) => {
  await open(page, "/", 1280);
  await lookUp(page, ["time"]);
  await box(page).fill("time");
  await expect(page.locator("main aside")).toContainText("Buscada 2 veces");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: messages.nav.log }).click();
  const row = page.locator("main section").first();
  await expect(row).toContainText("time");
  await expect(row).toContainText("2 VECES", { ignoreCase: true });
  expect((await row.boundingBox())!.height).toBeLessThan(60);
});

test("«Repasar ahora» in a word's history opens that word alone", async ({ page }) => {
  await open(page, "/", 1280);
  await lookUp(page, ["time", "bleak"]);
  await box(page).fill("time");
  await page.getByRole("link", { name: messages.story.reviewNow }).click();
  await expect(page).toHaveURL(/\/repaso\?palabra=time$/);
  await expect(page.getByText("1 de 1")).toBeVisible();
  await expect(page.locator("main")).toContainText("time");
  await expect(page.locator("main")).not.toContainText("bleak");
});
