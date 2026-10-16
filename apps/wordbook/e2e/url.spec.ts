import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the mount effect must never reach it in this suite.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// The debounce a settle waits out (`PHRASE_DEBOUNCE_MS` in
// `search-screen.tsx`, not exported) plus enough margin that a slow CI
// runner never reads the URL before the timer has actually fired. Also long
// enough past `useDecoration`'s own debounce, the same constant, for its
// pair of requests to have fired by the time this margin elapses.
const SETTLE_MARGIN_MS = 900;

async function openReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  // The fetch settling is not the worker posting "ready": buildIndex still
  // has to run over 64,258 entries. Give it room before the first keystroke.
  await page.waitForTimeout(1000);
}

test("pressing back after one lookup keeps the app open and empties the box", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("book");
  await expect(page.getByRole("heading", { name: "book" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MARGIN_MS);
  expect(page.url()).toContain("q=book");

  await page.goBack();

  // Still this app, on the same origin — not `about:blank`, the failure
  // this spec exists to close.
  expect(page.url()).not.toBe("about:blank");
  await expect(searchBox).toBeVisible();
  await expect(searchBox).toHaveValue("");
  await expect(page.getByText(messages.search.empty)).toBeVisible();
});

test("three lookups in a row leave three stops for back to walk, in order", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  await searchBox.fill("book");
  await expect(page.getByRole("heading", { name: "book" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MARGIN_MS);
  await searchBox.fill("");

  await searchBox.fill("sale");
  await expect(page.getByRole("heading", { name: "sale" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MARGIN_MS);
  await searchBox.fill("");

  await searchBox.fill("run");
  await expect(page.getByRole("heading", { name: "run" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MARGIN_MS);
  expect(page.url()).toContain("q=run");

  await page.goBack();
  await expect(searchBox).toHaveValue("sale");
  await expect(page.getByRole("heading", { name: "sale" })).toBeVisible();

  await page.goBack();
  await expect(searchBox).toHaveValue("book");
  await expect(page.getByRole("heading", { name: "book" })).toBeVisible();

  await page.goBack();
  await expect(searchBox).toHaveValue("");
  await expect(page.getByText(messages.search.empty)).toBeVisible();
});

test("opening /?q=serendipity cold answers it with no typing", async ({ page }) => {
  await deleteTranslator(page);

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/?q=serendipity");
  await assetResponse;
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await expect(searchBox).toHaveValue("serendipity");
  await expect(page.getByRole("heading", { name: "serendipity" })).toBeVisible({ timeout: 5000 });
});

// Retired 2026-09-09 (module 10): this drove `messages.source.open`, the
// search screen's own link to `/fuente`, which module 6 dropped
// (`components/search/source-note.tsx` no longer mounts anywhere). The
// licence's new home is `/cuenta`'s information tab, one tap from the bottom
// bar rather than one tap from the box (RL-33), so "the box's own trip out
// and back, unretyped" is no longer a claim `/fuente` makes. The behaviour
// this test actually proved — a round trip through another route leaves the
// box's word untyped — is what `e2e/bottom-nav.spec.ts` ("Buscar carries the
// query past a trip through Registro, unretyped", and its own loop over
// `/`, `/registro` and `/cuenta`) already drives for every route the bottom
// bar reaches, `/cuenta` included. Nothing here needs a replacement of its
// own.

test("typing ten letters adds one history entry, not ten", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  const before = await page.evaluate(() => window.history.length);

  await searchBox.pressSequentially("throughout", { delay: 30 });
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MARGIN_MS);

  const after = await page.evaluate(() => window.history.length);
  console.log(`history length before: ${before}, after ten keystrokes: ${after}`);
  expect(after - before).toBe(1);
});

test("no request leaves the device while typing, past the dictionary asset itself", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.pressSequentially("serendipity", { delay: 30 });
  await expect(page.getByRole("heading", { name: "serendipity" })).toBeVisible({ timeout: 5000 });

  // The instant the answer is painted, `useDecoration`'s own debounce has
  // not fired yet — this is the stricter bound: zero of anything, decoration
  // included, at the moment RL-35 promises an answer with nothing pending.
  const atPaint = requestUrls.filter(
    (url) => !url.includes(manifest.asset.path) && !url.includes("/_next/static/"),
  );
  expect(atPaint, `requests at paint, before decoration could fire: ${JSON.stringify(atPaint)}`).toEqual([]);

  await page.waitForTimeout(SETTLE_MARGIN_MS);

  // A lazily-loaded font past the fold is a rendering detail, not a lookup —
  // the box owes RL-14 no request of its own, and `_next/static/` never
  // carries one. Decoration's own pair is counted apart, below, never here.
  const stray = requestUrls.filter(
    (url) =>
      !url.includes(manifest.asset.path) &&
      !url.includes("/_next/static/") &&
      !url.includes("/api/word/"),
  );
  console.log(`requests while typing, dictionary asset, static assets and decoration excluded: ${stray.length}`);
  expect(stray).toEqual([]);

  // Ten keystrokes settle to one headword: at most one request per
  // decoration route, never one per keystroke.
  const decoration = requestUrls.filter((url) => url.includes("/api/word/"));
  console.log(`decoration requests for one settled word: ${decoration.length}`);
  expect(decoration.length, "decoration never asked").toBeGreaterThanOrEqual(1);
  expect(decoration.length).toBeLessThanOrEqual(2);
});
