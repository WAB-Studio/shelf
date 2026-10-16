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

// A lazily-loaded font past the fold is a rendering detail, not a lookup —
// `url.spec.ts:132` excludes it for the same reason, offline or not.
function strayRequests(urls: string[]): string[] {
  return urls.filter((url) => !url.includes("/_next/static/"));
}

// RL-28/RL-35: `recieve` is one transposition from `receive`, and the
// correction that draws it costs the network nothing — cut before typing so
// the claim is proven, not assumed. The offer itself is checked here;
// reaching it is checked separately, online, since a tap is a route change
// Next.js answers over the network regardless of how the offer was computed.
test("a one-edit typo offers the headword it was one edit from, with no request", async ({ page, context }) => {
  await deleteTranslator(page);
  await openReady(page);

  await context.setOffline(true);
  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("recieve");

  await expect(page.getByText(messages.search.notFound)).toBeVisible();
  await expect(page.getByText(messages.search.correctionTitle)).toBeVisible();
  await expect(page.getByRole("link", { name: "receive", exact: false })).toBeVisible();
  // notFoundHint is what today's app shows instead — it accuses the reader
  // of a bad spelling rather than offering a way out, and RL-28 replaces it
  // the moment a correction exists.
  await expect(page.getByText(messages.search.notFoundHint)).toHaveCount(0);

  const stray = strayRequests(requestUrls);
  console.log(`requests while offline and typing "recieve", static assets excluded: ${stray.length}`);
  expect(stray).toEqual([]);
});

// RL-28: "reaching one of them is a tap" — the offer is a real link to the
// word's own entry, not a relabel of the box.
test("tapping the offer opens the corrected word's own entry", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("recieve");

  const receiveLink = page.getByRole("link", { name: "receive", exact: false });
  await expect(receiveLink).toBeVisible();
  await receiveLink.click();

  await expect(page.getByRole("heading", { name: "receive" })).toBeVisible();
  await expect(searchBox).toHaveValue("receive");
});

// Decided by the user 2026-09-11: no cap on the candidate count, so a real
// English word the dictionary lacks (`fettle`) draws all four headwords one
// substitution away (kettle, mettle, nettle, settle) — wrong, and known to
// be wrong (`docs/voyager/DESIGN.md`, dated the same day) — until RL-29
// gives that reader a door that isn't a guess.
test("a word one edit from several headwords at once offers all of them", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("fettle");

  await expect(page.getByText(messages.search.notFound)).toBeVisible();
  await expect(page.getByText(messages.search.correctionTitle)).toBeVisible();
  await expect(page.getByText(messages.search.notFoundHint)).toHaveCount(0);
  for (const word of ["kettle", "mettle", "nettle", "settle"]) {
    await expect(page.getByRole("link", { name: word, exact: false })).toBeVisible();
  }
});

// "boz" sits one edit from nine real headwords, and has no prefix match of
// its own to suppress the miss with (RL-18). `suggestCorrection` sorts
// alphabetically, not by anything the reader meant, so cutting the list
// would drop the intended word by accident of spelling — decided
// 2026-09-11 (`docs/voyager/DESIGN.md`) to draw every candidate instead, at
// 360px, the narrowest viewport this suite runs.
test("nine candidates all draw, none of them off screen at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("boz");

  await expect(page.getByText(messages.search.correctionTitle)).toBeVisible();
  const links = page.locator("main").getByRole("link");
  await expect(links).toHaveCount(9);

  const boxes = await Promise.all((await links.all()).map((link) => link.boundingBox()));
  for (const box of boxes) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  }
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBe(360);
});

// `zzqqxv` sits no closer than two edits from any real headword: neither the
// correction nor a false "no clue" hint should appear for it — it gets the
// same plain miss the dictionary has always drawn for a genuine gap.
test("a word with no headword nearby gets the plain miss, not a wrong guess", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("zzqqxv");

  await expect(page.getByText(messages.search.notFound)).toBeVisible();
  await expect(page.getByText(messages.search.notFoundHint)).toBeVisible();
  await expect(page.getByText(messages.search.correctionTitle)).toHaveCount(0);
});
