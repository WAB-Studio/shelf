import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the mount effect must never reach it in this suite.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function gotoReady(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  // The fetch settling is not the worker posting "ready": buildIndex still
  // has to run over 64,258 entries.
  await page.waitForTimeout(1000);
}

async function search(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: messages.search.label }).fill(text);
}

// A translations line is one `<p>` holding the sense's glosses joined.
function line(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true });
}

// True when `a` comes before `b` in document order.
async function precedes(a: Locator, b: Locator): Promise<boolean> {
  const bHandle = await b.elementHandle();
  if (bHandle === null) throw new Error("second locator matched nothing");
  return a.evaluate(
    (el, other) => Boolean(el.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    bHandle,
  );
}

// RL-58 + RL-51 ("the first group" = the first category of the first
// pronunciation block, user 2026-10-08). `left` is an exact entry AND an
// inflection of `leave`; its own senses are verb, adjective, adverb, noun.
const OFFER = '«left» también es una forma de «leave»';
const FIRST_GROUP = "sobrado, sobras"; // left, verbo
const SECOND_GROUP = "izquierda, de izquierda, izquierdo"; // left, adjetivo
const LAST_GROUP_DEFINITION = "The left side or direction."; // left, sustantivo
const LEAVE_FIRST = "dejar, abandonar"; // prefix of leave's verb line

test("RL-58: left answers its first group, then the leave block, then the rest of left's groups", async ({
  page,
}) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "left");

  const header = page.getByText(OFFER, { exact: true });
  await expect(header).toBeVisible({ timeout: 5000 });
  const leaveHeading = page.getByRole("heading", { name: "leave", exact: true });
  const first = line(page, FIRST_GROUP);
  const second = line(page, SECOND_GROUP);
  const last = page.getByText(LAST_GROUP_DEFINITION, { exact: true });
  const leaveVerb = page.getByText(LEAVE_FIRST, { exact: false });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(last).toBeVisible();
  await expect(leaveVerb).toBeVisible();

  expect(await precedes(first, header), "left's first group comes before the offer").toBe(true);
  expect(await precedes(header, leaveHeading), "offer header, then the leave heading").toBe(true);
  expect(await precedes(leaveHeading, leaveVerb), "leave's own senses follow its heading").toBe(true);
  expect(await precedes(leaveVerb, second), "leave's block comes before left's second group").toBe(true);
  expect(await precedes(second, last), "left's groups keep their order after the lemma").toBe(true);
});

test("RL-58: only the first group sits above the offer, never a second one", async ({ page }) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "left");
  const header = page.getByText(OFFER, { exact: true });
  await expect(header).toBeVisible({ timeout: 5000 });

  // Every category label of left's answer above the offer header: one.
  const labelsAbove = await page.evaluate((offer) => {
    const main = document.querySelector("main");
    if (main === null) return null;
    const headerEl = Array.from(main.querySelectorAll("*")).find((n) => n.textContent === offer);
    if (!headerEl) return null;
    const pos = ["sustantivo", "adjetivo", "verbo", "nombre propio", "adverbio", "locución"];
    return Array.from(main.querySelectorAll("*"))
      .filter(
        (n) =>
          n.children.length === 0 &&
          pos.includes(n.textContent ?? "") &&
          Boolean(n.compareDocumentPosition(headerEl) & Node.DOCUMENT_POSITION_FOLLOWING),
      )
      .map((n) => n.textContent);
  }, OFFER);
  expect(labelsAbove).toEqual(["verbo"]);
});

test("RL-58: at 360 the top of the leave block is less than one viewport from the start of the answer", async ({
  page,
}) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "left");

  const heading = page.getByRole("heading", { name: "left", exact: true });
  const header = page.getByText(OFFER, { exact: true });
  await expect(header).toBeVisible({ timeout: 5000 });
  const viewport = page.viewportSize();
  expect(viewport?.width).toBe(360);

  const start = await heading.boundingBox();
  const offerTop = await header.boundingBox();
  if (start === null || offerTop === null || viewport === null) throw new Error("no box");
  expect(offerTop.y - start.y).toBeLessThan(viewport.height);
});

test("RL-58 keeps «forma primero»: the first heading is still left", async ({ page }) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "left");
  await expect(page.getByRole("heading", { name: "leave", exact: true })).toBeVisible({ timeout: 5000 });
  const headings = await page.locator("main").getByRole("heading").allTextContents();
  expect(headings[0]).toBe("left");
  expect(headings.indexOf("leave")).toBeGreaterThan(0);
});

test("RL-58: a word with no inflection (apple) answers alone", async ({ page }) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "apple");
  await expect(page.getByRole("heading", { name: "apple", exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("es una forma de", { exact: false })).toHaveCount(0);
  await expect(page.getByText("también es una forma", { exact: false })).toHaveCount(0);
  await expect(page.locator("main").getByRole("heading")).toHaveCount(1);
  await expect(line(page, "manzana, poma")).toBeVisible();
});

test("RL-58 keeps the bed clause: bed answers whole and offers no lemma block", async ({ page }) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "bed");
  await expect(page.getByRole("heading", { name: "bed", exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("es una forma de", { exact: false })).toHaveCount(0);
  await expect(page.locator("main").getByRole("heading")).toHaveCount(1);
  // Both of bed's groups are there, noun then verb.
  await expect(page.getByText("cama, lecho", { exact: false })).toBeVisible();
  await expect(page.getByText("encamarse", { exact: false })).toBeVisible();
});

// `said` draws two pronunciation blocks (/seɪd/ adjective, /saɪd/ proper
// noun) and is an inflection of `say`: the offer sits under the first
// category of block 1, never under block 2's.
test("RL-58: with two pronunciation blocks the offer sits under block 1's first group, above block 2", async ({
  page,
}) => {
  await deleteTranslator(page);
  await gotoReady(page);
  await search(page, "said");

  const header = page.getByText('«said» también es una forma de «say»', { exact: true });
  await expect(header).toBeVisible({ timeout: 5000 });
  const blockOneGroup = line(page, "dicho");
  const lemmaVerb = line(page, "decir, poner, digamos, se dice");
  const blockTwoGroup = line(page, "Saíd");
  await expect(blockOneGroup).toBeVisible();
  await expect(lemmaVerb).toBeVisible();
  await expect(blockTwoGroup).toBeVisible();

  expect(await precedes(blockOneGroup, header), "block 1's first group comes before the offer").toBe(true);
  expect(await precedes(header, lemmaVerb), "the say block follows its header").toBe(true);
  expect(await precedes(lemmaVerb, blockTwoGroup), "block 2 comes after the say block").toBe(true);
});
