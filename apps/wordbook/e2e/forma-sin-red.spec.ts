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
  // aria-busy turns false once the worker has built its index and the install is done.
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();
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
  lemma: null,
  rule: null,
};

const FORM_OF_WENT = "«went» es una forma de «go»";

// The UNLISTED requests a page sent, read after the screen has drawn.
function trackUnlisted(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(UNLISTED)) sent.push(request.url());
  });
  return sent;
}

// `went` has no entry of its own: the form leads, `go` sits under it. The
// dictionary resolves its lemma, so the paid route is never asked (RL-44).
test("went: the form and its lemma answer, and nothing is asked of the network", async ({ page, stubUnlisted }) => {
  await deleteTranslator(page);
  await stubUnlisted(FORM_ANSWER);
  await openReady(page);
  const sent = trackUnlisted(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("went");
  await expect(page.getByRole("heading", { name: "went", exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(FORM_OF_WENT)).toBeVisible();
  await expect(page.getByRole("heading", { name: "go", exact: true })).toBeVisible();

  await afterRender(page);
  expect(sent).toEqual([]);
  await expect(page.getByText(messages.word.networkAnswerTitle)).toHaveCount(0);
  await expect(page.getByText(messages.word.networkFailed)).toHaveCount(0);
  await expect(page.locator("[data-network-answer]")).toHaveCount(0);
});

test("went: the lemma box is the first thing under the heading", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("went");
  const heading = page.getByRole("heading", { name: "went", exact: true });
  await expect(heading).toBeVisible({ timeout: 5000 });
  await afterRender(page);

  const headingBox = (await heading.boundingBox())!;
  const labelBox = (await page.getByText(FORM_OF_WENT).boundingBox())!;
  expect(labelBox.y).toBeGreaterThan(headingBox.y);
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

test("whereat: the offer for whereas stands and nothing is asked of the network", async ({ page, stubUnlisted }) => {
  await deleteTranslator(page);
  await stubUnlisted({ ...FORM_ANSWER, translations: ["¿en dónde?"] });
  await openReady(page);
  const sent = trackUnlisted(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill("whereat");
  await expect(page.getByText(messages.search.correctionTitle)).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("link", { name: "whereas", exact: false })).toBeVisible();
  await afterRender(page);

  expect(sent).toEqual([]);
  await expect(page.getByText(messages.word.networkAnswerTitle)).toHaveCount(0);
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
