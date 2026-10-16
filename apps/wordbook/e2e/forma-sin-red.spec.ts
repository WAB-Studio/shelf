import { expect, test, STUB_HEADER } from "./fixtures";
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
  // The fetch settling is not the worker posting "ready" (buildIndex runs over
  // the whole dictionary); same room the sibling specs give.
  await page.waitForTimeout(1000);
}

// Two animation frames: React has committed whatever the settled request set.
// A `toHaveCount(0)` right after the request alone would pass before the
// state lands, and so prove nothing.
async function afterRender(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

const UNLISTED = "/api/word/unlisted";

const FORM_ANSWER = {
  translations: ["fue"],
  definition: "Past tense of go.",
  example: { en: "She went home.", es: "Ella se fue a casa." },
  lemma: null,
  rule: null,
};

const FORM_OF_WENT = "«went» es una forma de «go»";

// `went` has no entry of its own: the form leads, `go` sits under it.
// RL-35, RL-44, RL-58: a failed network answer is not a thing this screen
// says about a word the dictionary already answered.
test("went offline: the form and its lemma answer, and no network-failure line", async ({ page, context }) => {
  await deleteTranslator(page);
  await openReady(page);
  await context.setOffline(true);
  // A fulfilling route answers even with the context offline, so the failure
  // the reader's offline phone gives the fetch is modelled by the abort.
  await page.route(`**${UNLISTED}`, (route) => route.abort("internetdisconnected"));
  const failed = page.waitForEvent("requestfailed", (request) => request.url().includes(UNLISTED));

  await page.getByRole("textbox", { name: messages.search.label }).fill("went");
  await expect(page.getByRole("heading", { name: "went", exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(FORM_OF_WENT)).toBeVisible();
  await expect(page.getByRole("heading", { name: "go", exact: true })).toBeVisible();

  await failed;
  await afterRender(page);
  await expect(page.getByText(messages.word.networkFailed)).toHaveCount(0);
  await expect(page.locator("[data-network-answer]")).toHaveCount(0);
});

test("went with the route answering 204: no network-failure line either", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);
  // The fixture's default answer is the 204.
  const answered = page.waitForResponse((r) => r.url().includes(UNLISTED) && r.status() === 204);

  await page.getByRole("textbox", { name: messages.search.label }).fill("went");
  await expect(page.getByText(FORM_OF_WENT)).toBeVisible({ timeout: 5000 });

  await answered;
  await afterRender(page);
  await expect(page.getByText(messages.word.networkFailed)).toHaveCount(0);
  await expect(page.locator("[data-network-answer]")).toHaveCount(0);
});

test("went with no network answer: the lemma box is the first thing under the heading", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);
  const answered = page.waitForResponse((r) => r.url().includes(UNLISTED));

  await page.getByRole("textbox", { name: messages.search.label }).fill("went");
  const heading = page.getByRole("heading", { name: "went", exact: true });
  await expect(heading).toBeVisible({ timeout: 5000 });
  await answered;
  await afterRender(page);

  // Reading order: heading, then the lemma's label, with nothing of the
  // network drawn between them.
  const order = await page.evaluate((label) => {
    const main = document.querySelector("main")!;
    const all = Array.from(main.querySelectorAll("*"));
    const h = all.findIndex((el) => el.tagName === "H1" || el.tagName === "H2" || el.tagName === "H3");
    const lemma = all.findIndex((el) => el.children.length === 0 && el.textContent === label);
    const between = all.slice(h + 1, lemma).filter((el) => el.hasAttribute("data-network-answer"));
    return { h, lemma, between: between.length };
  }, FORM_OF_WENT);
  expect(order.h).toBeGreaterThanOrEqual(0);
  expect(order.lemma).toBeGreaterThan(order.h);
  expect(order.between).toBe(0);
  const headingBox = (await heading.boundingBox())!;
  const labelBox = (await page.getByText(FORM_OF_WENT).boundingBox())!;
  expect(labelBox.y).toBeGreaterThan(headingBox.y);
});

test("went with a network answer: «Respuesta de internet» sits above the lemma block", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted(FORM_ANSWER);
  await openReady(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("went");
  const title = page.getByText(messages.word.networkAnswerTitle);
  await expect(title).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(FORM_OF_WENT)).toBeVisible();

  const titleBox = (await title.boundingBox())!;
  const lemmaBox = (await page.getByText(FORM_OF_WENT).boundingBox())!;
  const headingBox = (await page.getByRole("heading", { name: "went", exact: true }).boundingBox())!;
  expect(titleBox.y).toBeGreaterThan(headingBox.y);
  expect(titleBox.y).toBeLessThan(lemmaBox.y);
  await expect(page.getByText(messages.word.networkFailed)).toHaveCount(0);
});

// `coccidiosis`: no entry, no form, no headword near enough to correct.
test("coccidiosis resolved: neither «no tiene» nor the spelling hint, and the answer is on screen", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted({ ...FORM_ANSWER, translations: ["coccidiosis"] });
  await openReady(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("coccidiosis");
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 5000 });
  await afterRender(page);

  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
  await expect(page.getByText(messages.search.notFoundHint)).toHaveCount(0);
});

test("coccidiosis pending: «no tiene» stands, the spelling hint does not", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**${UNLISTED}`, async (route) => {
    await held;
    await route.fulfill({ status: 204, headers: { [STUB_HEADER]: "1" } });
  });

  await page.getByRole("textbox", { name: messages.search.label }).fill("coccidiosis");
  await expect(page.getByText(messages.word.networkPending)).toBeVisible({ timeout: 5000 });

  await expect(page.getByText(messages.search.notFound)).toBeVisible();
  await expect(page.getByText(messages.search.notFoundHint)).toHaveCount(0);
  release();
});

test("coccidiosis failed (204): «no tiene», the hint and the failure line all stand", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("coccidiosis");
  await expect(page.getByText(messages.word.networkFailed)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.search.notFound)).toBeVisible();
  await expect(page.getByText(messages.search.notFoundHint)).toBeVisible();
});

test("whereat resolved: the offer for whereas and the answer, and no «no tiene»", async ({
  page,
  stubUnlisted,
}) => {
  await deleteTranslator(page);
  await stubUnlisted({ ...FORM_ANSWER, translations: ["¿en dónde?"] });
  await openReady(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("whereat");
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.search.correctionTitle)).toBeVisible();
  await expect(page.getByRole("link", { name: "whereas", exact: false })).toBeVisible();
  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
});

// A word with no entry that will go to the network: the hint is held back from
// the first keystroke until the network says no, and the wait shows meanwhile.
test("coccidiosis slow network: the spelling hint never shows before the network answered, and shows after it failed", async ({
  page,
}) => {
  await deleteTranslator(page);
  await openReady(page);

  await page.route(`**${UNLISTED}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 204, headers: { [STUB_HEADER]: "1" } });
  });

  // `innerText`, not `textContent`: the latter reads the page's script payload.
  await page.evaluate(
    ([hint, failed]) => {
      const w = window as unknown as { __hintEarly: boolean };
      w.__hintEarly = false;
      new MutationObserver(() => {
        const text = document.body.innerText;
        if (text.includes(hint) && !text.includes(failed)) w.__hintEarly = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    },
    [messages.search.notFoundHint, messages.word.networkFailed],
  );

  await page.getByRole("textbox", { name: messages.search.label }).fill("coccidiosis");
  await expect(page.getByText(messages.word.networkPending)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.search.notFoundHint)).toHaveCount(0);

  await expect(page.getByText(messages.word.networkFailed)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.search.notFoundHint)).toBeVisible();

  const early = await page.evaluate(() => (window as unknown as { __hintEarly: boolean }).__hintEarly);
  expect(early, "the hint was on screen before the network answered").toBe(false);
});
