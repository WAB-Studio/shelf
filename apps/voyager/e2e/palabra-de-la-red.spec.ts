import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import { PHRASE_DEBOUNCE_MS } from "../lib/query/settle";
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
  // has to run over 64,258 entries. The install line is server-rendered in
  // the booting state and every state but ready keeps one, so its absence is
  // the worker's own "ready".
  await expect(page.getByText(/Instalando el diccionario/)).toHaveCount(0);
}

// `use-network-answer.ts` waits `PHRASE_DEBOUNCE_MS` (600ms) after the box
// settles before it asks, and that wait starts when React commits the
// keystroke, not when `fill` returns. A fixed budget over it left 300ms and
// failed 7 runs in 20 on a busy machine; the request leaving is the event to
// wait on, and the draw after it gets the ordinary timeout.
//
// Registered before the keystroke, so the response cannot slip past it.
function unlistedAnswered(page: Page): Promise<unknown> {
  return page.waitForResponse((response) => response.url().includes("/api/word/unlisted"));
}

// Margin after one debounce window for a request to reach `page.on("request")`.
const REQUEST_DELIVERY_MS = 300;

const UNLISTED_ANSWER = {
  translations: ["coccidiosis"],
  definition: "A parasitic disease of the intestine.",
  example: { en: "The flock was tested for coccidiosis.", es: "Se examinó a la parvada por coccidiosis." },
  lemma: null,
  rule: null,
};

// `coccidiosis` (module 5's own cold-miss word): no exact entry, no
// inflection candidate, no headword near enough to correct — the plainest
// of the two shapes this module opens the network for.
test("coccidiosis: the network block draws under the miss line, 200", async ({ page, stubUnlisted }) => {
  await deleteTranslator(page);
  await stubUnlisted(UNLISTED_ANSWER);
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  const answered = unlistedAnswered(page);
  await searchBox.fill("coccidiosis");
  await answered;

  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible();
  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
  await expect(page.getByText(messages.search.notFoundHint)).toHaveCount(0);
  await expect(page.getByText(UNLISTED_ANSWER.translations[0], { exact: true })).toBeVisible();
  await expect(page.getByText(UNLISTED_ANSWER.definition!)).toBeVisible();
  await expect(page.getByText(UNLISTED_ANSWER.example.en)).toBeVisible();
});

// RL-28's correction offer and RL-44's network answer are two different
// answers to the same miss, and neither replaces the other: `whereat` has a
// real candidate (`whereas`) one edit away, and this module still asks the
// network on its behalf. Ver `## Preguntas`, 1 in the slice plan — this is
// the line that changes if the user decides otherwise, and no other.
test("whereat: the correction offer and the network block draw together", async ({ page, stubUnlisted }) => {
  await deleteTranslator(page);
  await stubUnlisted({ ...UNLISTED_ANSWER, translations: ["¿en dónde?"] });
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  const answered = unlistedAnswered(page);
  await searchBox.fill("whereat");

  await expect(page.getByText(messages.search.correctionTitle)).toBeVisible();
  await expect(page.getByRole("link", { name: "whereas", exact: false })).toBeVisible();
  await answered;
  await expect(page.getByText(messages.word.networkAnswerTitle)).toBeVisible();
});

// A prefix mid-word has no exact hit, no inflected hit and no answer on
// screen to attach a network block to — `suppressNotFound` holds, and
// asking here would charge every paused keystroke a reader never finished.
test("ru: the suggestion list holds, and no request reaches /api/word/unlisted", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("ru");

  // The list drawing is the proof the keystroke committed; the debounce timer
  // started at or before that commit, so one window from here has elapsed
  // however slow the machine, and a request, had one been due, has left.
  await expect(page.getByText(messages.word.suggestions)).toBeVisible();
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + REQUEST_DELIVERY_MS);
  await expect(page.getByText(messages.search.notFound)).toHaveCount(0);
  const unlistedRequests = requestUrls.filter((url) => url.includes("/api/word/unlisted"));
  expect(unlistedRequests, `unexpected /api/word/unlisted requests: ${JSON.stringify(unlistedRequests)}`).toEqual(
    [],
  );
});

// 204 is RL-44's own absence, and the only thing it adds to the miss screen
// is the one line that says the network could not answer either — nothing
// else moves compared to the 200 case above.
test("coccidiosis: 204 draws today's screen plus one line, and nothing else", async ({ page }) => {
  await deleteTranslator(page);
  // No `stubUnlisted` call: the fixture's own default is 204 (module 10's
  // "no key, over a cap, a provider failure" all collapse to this).
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  const answered = unlistedAnswered(page);
  await searchBox.fill("coccidiosis");
  await answered;

  await expect(page.getByText(messages.search.notFound)).toBeVisible();
  await expect(page.getByText(messages.word.networkFailed)).toBeVisible();
  await expect(page.getByText(messages.word.networkAnswerTitle)).toHaveCount(0);
  await expect(page.getByText(messages.word.networkTranslations)).toHaveCount(0);
});
