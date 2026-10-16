import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import { FUNCTION_WORDS, functionWordTranslation } from "../lib/phrase/function-words";
import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the mount effect must never reach it in this suite.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

// `search-screen.tsx`'s own constant, not exported: the debounce a sentence
// waits out before it is worth asking about (RNL-05, rule 1). The no-entry
// path below the floor and above the ceiling never waits on this at all.
const PHRASE_DEBOUNCE_MS = 600;

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

// `BottomNav` carries a heading of its own (`bottom-nav.tsx:148`), outside
// `<main>`, on every screen — scoping to `main` is what keeps that title out
// of a count this spec means for the answer alone.
function mainHeadings(page: Page) {
  return page.locator("main").getByRole("heading");
}

// A lazily-loaded font past the fold is a rendering detail, not a lookup —
// `url.spec.ts:132` excludes it for the same reason, offline or not: it is
// served from the browser's own cache and still raises a `request` event.
function strayRequests(urls: string[]): string[] {
  return urls.filter((url) => !url.includes("/_next/static/"));
}

test("a two-token miss draws both headwords, offline, with no request", async ({ page, context }) => {
  await deleteTranslator(page);
  await openReady(page);

  // RL-16/RNL-01: the answer to a word never touches the network — cutting
  // it here proves the claim rather than assuming it.
  await context.setOffline(true);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("hello world");

  await expect(mainHeadings(page).filter({ hasText: "hello" })).toBeVisible();
  await expect(mainHeadings(page).filter({ hasText: "world" })).toBeVisible();
  await expect(mainHeadings(page)).toHaveCount(2);

  const expectedTitle = messages.search.noEntry.title.replace("{query}", "hello world");
  await expect(page.getByText(expectedTitle)).toBeVisible();

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  const stray = strayRequests(requestUrls);
  console.log(`requests while offline and typing "hello world", static assets excluded: ${stray.length}`);
  expect(stray).toEqual([]);
});

// "zzqx" is absent from `eng-spa-2025.11.23.json` as a headword, and no
// inflection rule in `lib/dictionary/inflect.ts` strips a suffix off it —
// there is nothing left for `lookupWord` to find under any of its rules.
// Two tokens now reaches the translator online, like any other phrase
// (module 30) — only a failed translation still falls to this breakdown,
// same as the "dog cat" case above, so the route is stubbed to fail here too.
test("a two-token miss where the dictionary lacks one word draws that word's own heading and its own miss, and the other's answer", async ({
  page,
}) => {
  await deleteTranslator(page);
  let translateCount = 0;
  await page.route("**/api/translate", async (route) => {
    translateCount++;
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "provider" }) });
  });
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("hello zzqx");

  await expect(mainHeadings(page).filter({ hasText: "hello" })).toBeVisible();
  // The word that broke the phrase is the one word this screen must be able
  // to locate: it draws its own heading like every other block, not silence
  // above its "tampoco" line.
  await expect(mainHeadings(page).filter({ hasText: "zzqx" })).toBeVisible();
  await expect(mainHeadings(page)).toHaveCount(2);
  await expect(page.getByText(messages.search.noEntry.wordMiss)).toBeVisible();
  const failedTitle = messages.search.noEntry.titleTranslationFailed.replace("{query}", "hello zzqx");
  await expect(page.getByText(failedTitle)).toBeVisible();

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  expect(translateCount, "the translation is attempted once, and fails").toBe(1);
});

test("a 61-token string draws one line and no heading, and asks the dictionary nothing", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  const tooLongText = Array.from({ length: 61 }, (_, index) => `palabra${index}`).join(" ");
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(tooLongText);

  const expectedTooLong = messages.search.noEntry.tooLong.replace("{count}", "61");
  await expect(page.getByText(expectedTooLong)).toBeVisible();
  await expect(mainHeadings(page)).toHaveCount(0);

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  const stray = strayRequests(requestUrls);
  console.log(`requests past the ceiling, static assets excluded: ${stray.length}`);
  expect(stray).toEqual([]);
});

test("the cat sits still debounces to exactly one translate request, 600ms after the last keystroke", async ({
  page,
}) => {
  await deleteTranslator(page);
  let translateCount = 0;
  await page.route("**/api/translate", async (route) => {
    translateCount++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "El gato se sienta", origin: "network" }),
    });
  });
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("the cat sits");

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS - 100);
  expect(translateCount, "nothing is asked before the debounce settles").toBe(0);

  await page.waitForTimeout(300);
  expect(translateCount, "exactly one request once it does").toBe(1);
  await expect(page.getByText("El gato se sienta")).toBeVisible();
});

// `/fuente` itself is gone (module 10 was its last tenant), so this no
// longer guards a live route. It still guards the search screen's own
// markup: `SourceNote` or anything like it must never remount here, whether
// or not a route by that name exists to receive the click.
test("the search screen carries no link to /fuente", async ({ page }) => {
  await deleteTranslator(page);
  await openReady(page);

  await expect(page.locator('a[href="/fuente"]')).toHaveCount(0);
});

// RL-37. Nine distinct headwords plus "zzqx", which the dictionary lacks —
// no word repeats, so `mainHeadings` never double-counts one that folds into
// the "more" line and one that's shown at the same time. The route is
// intercepted rather than left to MyMemory's own quota, mirroring exactly
// what `app/api/translate/route.ts` answers once `translateWithProvider`
// throws: a 502 with no `translatedText` a client ever reads.
test("a phrase whose translation fails falls to the per-word breakdown, capped at eight blocks with the rest in one line", async ({
  page,
}) => {
  await deleteTranslator(page);
  let translateCount = 0;
  await page.route("**/api/translate", async (route) => {
    translateCount++;
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "provider" }) });
  });
  await openReady(page);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  const phraseText = "dog cat zzqx bird fish mouse horse cow pig";
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(phraseText);

  // The debounce, the failed request, and the on-device breakdown all have
  // to land before any of this is worth reading.
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  expect(translateCount, "the translation is attempted once, and fails").toBe(1);

  const expectedTitle = messages.search.noEntry.titleTranslationFailed.replace("{query}", phraseText);
  await expect(page.getByText(expectedTitle)).toBeVisible();

  // The first eight tokens each draw a block, including "zzqx", the third:
  // the dictionary's own miss line still runs below it, but the heading
  // above it names the word like every other block's does.
  for (const shown of ["dog", "cat", "zzqx", "bird", "fish", "mouse", "horse", "cow"]) {
    await expect(mainHeadings(page).filter({ hasText: shown })).toBeVisible();
  }
  await expect(page.getByText(messages.search.noEntry.wordMiss)).toBeVisible();

  // "pig" is the ninth token: past `MAX_BLOCKS`, it never gets its own
  // block — only the "N more" line below names it indirectly, by count.
  await expect(mainHeadings(page).filter({ hasText: "pig" })).toHaveCount(0);
  await expect(mainHeadings(page)).toHaveCount(8);
  await expect(page.getByText("…y 1 palabra más: pig.")).toBeVisible();

  // docs/voyager/DESIGN.md "A word block on `SinEntradaFrase` carries its
  // translations alone": no IPA, no definition anywhere in the breakdown.
  // "dog" (eng-spa-2025.11.23.json) carries both on a direct lookup —
  // "/dɑɡ/" and "(transitive) To pursue with the intent to catch." — and
  // neither draws here.
  await expect(page.getByText("/dɑɡ/")).toHaveCount(0);
  await expect(page.getByText("(transitive) To pursue with the intent to catch.")).toHaveCount(0);
  await expect(page.getByText(messages.word.definitionEnglish)).toHaveCount(0);

  // The voice control belongs to the word screen's own four boards alone
  // (docs/voyager/DESIGN.md), never to this breakdown.
  await expect(page.getByRole("button", { name: /^Escuchar/ })).toHaveCount(0);

  // RL-37: the breakdown itself answers from the device — the one request
  // this test allows is the translation attempt that failed, not a second
  // one per word.
  const stray = strayRequests(requestUrls).filter((url) => !url.includes("/api/translate"));
  console.log(`requests past the failed translate call, static assets and the call itself excluded: ${stray.length}`);
  expect(stray).toEqual([]);
});

// Two tokens is the phrasal-verb case — "toiling up", "give in" — whose
// meaning is not the sum of its parts, so it goes to the translator like
// any other phrase. When the translator fails it still falls back to the
// word-by-word breakdown, which is what this asserts: reaching the route
// and failing must not cost the reader the breakdown they had before.
test("a two-token string reaches the translator, and falls back to the breakdown when it fails", async ({
  page,
}) => {
  await deleteTranslator(page);
  let translateCount = 0;
  await page.route("**/api/translate", async (route) => {
    translateCount++;
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "provider" }) });
  });
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("dog cat");

  await expect(mainHeadings(page).filter({ hasText: "dog" })).toBeVisible();
  await expect(mainHeadings(page).filter({ hasText: "cat" })).toBeVisible();
  const failedTitle = messages.search.noEntry.titleTranslationFailed.replace("{query}", "dog cat");
  await expect(page.getByText(failedTitle)).toBeVisible();

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  expect(translateCount, "a two-token string reaches the translate route exactly once").toBe(1);
});

// The floor itself: one token is a word, never a phrase, whatever the
// dictionary says about it. Nothing below two may reach the network.
test("a one-token miss never reaches the translator", async ({ page }) => {
  await deleteTranslator(page);
  let translateCount = 0;
  await page.route("**/api/translate", async (route) => {
    translateCount++;
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "provider" }) });
  });
  await openReady(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill("zzzqqq");

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  expect(translateCount, "a single token never reaches the translate route").toBe(0);
});

// docs/voyager/DESIGN.md "Every block of the breakdown is a way back in":
// every shown block, hit or miss, and the "more" line all lead to
// `/?q=<word>` — the only door out of a breakdown used to be retyping the
// box from scratch.
test("every block and the trailing line lead back to /?q=<word>, and that screen answers it", async ({
  page,
}) => {
  await deleteTranslator(page);
  await page.route("**/api/translate", async (route) => {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "provider" }) });
  });
  await openReady(page);

  const phraseText = "she kept her fettle through the long and bitter winter";
  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(phraseText);

  const expectedTitle = messages.search.noEntry.titleTranslationFailed.replace("{query}", phraseText);
  await expect(page.getByText(expectedTitle)).toBeVisible();

  // "fettle" is the block the dictionary itself misses; its own heading is
  // still a door, even with nothing behind it.
  await page.locator('main a[href="/?q=fettle"]').click();
  await expect(page).toHaveURL(/\/\?q=fettle$/);
  await expect(page.getByText(messages.search.notFound)).toBeVisible();

  await page.goBack();
  await expect(page.getByText(expectedTitle)).toBeVisible();

  // "she" hit the dictionary inside the breakdown, compact; its door reaches
  // the same word's full answer — IPA, definition, voice, the lot.
  await page.locator('main a[href="/?q=she"]').click();
  await expect(page).toHaveURL(/\/\?q=she$/);
  await expect(page.getByRole("heading", { name: "she", exact: true })).toBeVisible();
  // RL-59: `she` is a function word, so the dictionary's lines sit folded.
  await page.locator("main").getByRole("button", { name: messages.search.noEntry.showDictionary }).click();
  await expect(page.getByText(messages.word.translations)).toBeVisible();

  await page.goBack();
  await expect(page.getByText(expectedTitle)).toBeVisible();

  // Blocks 1-8 are she/kept/her/fettle/through/the/long/and; "bitter" and
  // "winter" fall past `MAX_BLOCKS` and the trailing line is their own door,
  // naming both and reaching the first.
  const more = page.locator("main a", { hasText: "bitter" });
  await expect(more).toHaveText("…y 2 palabras más: bitter, winter.");
  await more.click();
  await expect(page).toHaveURL(/\/\?q=bitter$/);
  await expect(page.getByRole("heading", { name: "bitter", exact: true })).toBeVisible();
});

// RL-57 / module 559 (docs/voyager/DESIGN.md `SinEntradaFraseFuncion`): in the
// per-word breakdown a function word leads with the table's translation and
// the dictionary's own line follows, muted. The expected strings come from the
// table's own function, never from the component.
async function failTranslation(page: Page): Promise<void> {
  await page.route("**/api/translate", async (route) => {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "provider" }) });
  });
}

type Line = { text: string; color: string };

// Every leaf text between a word's heading and the next block's heading (or the
// end of the answer), in reading order: the block's lines without naming the
// component or a class.
async function blockLines(page: Page, word: string, next: string | null): Promise<Line[]> {
  const from = await top(page, mainHeadings(page).filter({ hasText: new RegExp(`^${word}$`) }));
  const to = next === null ? Infinity : await top(page, mainHeadings(page).filter({ hasText: new RegExp(`^${next}$`) }));
  return page.locator("main *").evaluateAll(
    (nodes, [lo, hi]) =>
      nodes
        .filter((node) => node.children.length === 0 && !node.closest("h1, h2, h3"))
        .map((node) => ({
          y: node.getBoundingClientRect().top + window.scrollY,
          text: (node.textContent ?? "").trim(),
          color: getComputedStyle(node).color,
        }))
        .filter((n) => n.text !== "" && n.y > lo && n.y < hi)
        .sort((x, y) => x.y - y.y)
        .map(({ text, color }) => ({ text, color })),
    [from, to] as [number, number],
  );
}

async function top(page: Page, locator: ReturnType<Page["getByText"]>): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not on screen");
  return box.y + (await page.evaluate(() => window.scrollY));
}

async function breakdown(page: Page, query: string): Promise<void> {
  await page.getByRole("textbox", { name: messages.search.label }).fill(query);
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 400);
  await expect(page.getByText(messages.search.noEntry.titleTranslationFailed.replace("{query}", query))).toBeVisible();
}


// Module 681. The board's words (SinEntradaFuncionPlegadaOscuroMovil): no
// message key exists yet for the control, so the spec states the text the
// board draws.
const FOLDED_LABEL = "ver el diccionario";
const OPEN_LABEL = "ocultar el diccionario";

// The control that follows a word's heading in reading order: the word's own,
// for a function word, without naming a component or a class.
function controlOf(page: Page, word: string) {
  return mainHeadings(page)
    .filter({ hasText: new RegExp(`^${word}$`) })
    .locator("xpath=following::button[@aria-expanded][1]");
}

async function unfold(page: Page, word: string): Promise<void> {
  const control = controlOf(page, word);
  await expect(control).toHaveAttribute("aria-expanded", "false");
  await control.click();
  await expect(control).toHaveAttribute("aria-expanded", "true");
}

function visible(page: Page, text: string) {
  return page.locator("main").getByText(text, { exact: true }).locator("visible=true");
}

function formLine(key: "viaInflectionWithEntry" | "formOf", surface: string, lemma: string): string {
  return messages.word[key].replace("{surface}", surface).replace("{lemma}", lemma);
}

async function sentence(page: Page, query: string): Promise<void> {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);
  await breakdown(page, query);
}

const GLOSSES = new Set(Array.from(FUNCTION_WORDS.values()));

test("a function word's block starts with the table translation and the dictionary's line follows it", async ({ page }) => {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);
  const tableText = functionWordTranslation("something") as string;
  expect(tableText, "558's table owns `something`").not.toBeNull();

  await breakdown(page, "something weird happened");
  await unfold(page, "something");
  const lines = (await blockLines(page, "something", "weird")).map((l) => l.text);
  expect(lines[0], "the table's translation leads the block").toBe(tableText);
  expect(lines.indexOf("basurita"), "the dictionary's own line follows it").toBeGreaterThan(0);
});

test("the dictionary line under a function word is muted, the table line is not", async ({ page }) => {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);

  await breakdown(page, "she whispered something nobody heard");
  await unfold(page, "she");
  const she = await blockLines(page, "she", "whispered");
  const whispered = await blockLines(page, "whispered", "something");
  const plain = whispered.find((l) => l.text === "susurrar, chamuyar, gaguear, shushushar");
  expect(plain, "a content word's translation, today's tone").toBeDefined();

  expect(she[0].text).toBe(functionWordTranslation("she"));
  expect(she[0].color, "the table line wears the unmuted tone").toBe(plain?.color);
  const dictionaryLine = she.slice(1).find((l) => l.text === "ella");
  expect(dictionaryLine, "the dictionary's line stays under the table's").toBeDefined();
  expect(dictionaryLine?.color, "and sits muted").not.toBe(plain?.color);
});

test("the board's sentence: she and nobody lead with the table, whispered and heard stay as the dictionary has them", async ({
  page,
}) => {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);

  await breakdown(page, "she whispered something nobody heard");
  expect((await blockLines(page, "she", "whispered"))[0].text).toBe(functionWordTranslation("she"));
  expect((await blockLines(page, "nobody", "heard"))[0].text).toBe(functionWordTranslation("nobody"));
  expect((await blockLines(page, "something", "nobody"))[0].text).toBe(functionWordTranslation("something"));

  for (const [word, next] of [["whispered", "something"], ["heard", null]] as const) {
    const lines = (await blockLines(page, word, next)).map((l) => l.text);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => GLOSSES.has(line)), `${word} takes nothing from the table`).toEqual([]);
  }
});

test("a function word written with a capital is headed by the dictionary's entry, not by what was typed", async ({ page }) => {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);

  await breakdown(page, "She whispered something nobody heard");
  const headings = mainHeadings(page);
  await expect(headings.filter({ hasText: /^she$/ }), "the entry's own headword").toHaveCount(1);
  await expect(headings.filter({ hasText: /^She$/ }), "not the written token").toHaveCount(0);
  // The block still leads with the table's line under that heading.
  expect((await blockLines(page, "she", "whispered"))[0].text).toBe(functionWordTranslation("she"));
});

test("a content word's block draws the dictionary alone", async ({ page }) => {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);

  await breakdown(page, "something weird happened");
  const lines = (await blockLines(page, "weird", "happened")).map((l) => l.text);
  expect(lines.length, "weird draws its senses").toBeGreaterThan(0);
  expect(lines.filter((line) => GLOSSES.has(line))).toEqual([]);
  expect(lines).toContain("raro, anormal, bizarro, cuático, extraño");
});

test("offline, the breakdown still leads with the table translation and asks for nothing", async ({ page, context }) => {
  await deleteTranslator(page);
  await openReady(page);
  await context.setOffline(true);

  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));
  await page.getByRole("textbox", { name: messages.search.label }).fill("something weird happened");
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 600);

  const lines = (await blockLines(page, "something", "weird")).map((l) => l.text);
  expect(lines[0]).toBe(functionWordTranslation("something"));
  const stray = strayRequests(requestUrls).filter((url) => !url.includes("/api/translate"));
  expect(stray).toEqual([]);
});

test("past sixty words of function words, the line stands alone with no block and no table line", async ({ page }) => {
  await deleteTranslator(page);
  await failTranslation(page);
  await openReady(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill(Array.from({ length: 61 }, () => "something").join(" "));
  await expect(page.getByText(messages.search.noEntry.tooLong.replace("{count}", "61"))).toBeVisible();
  await expect(mainHeadings(page)).toHaveCount(0);
  await expect(page.getByText(functionWordTranslation("something") as string, { exact: true })).toHaveCount(0);
});

// Module 681 / RL-58 inside the breakdown (SinEntradaLemaCompactoOscuroMovil):
// the lemma block of a form with an exact entry sits under the form's first
// group, as on the word page. Expectations are the board's words and the
// dictionary's rows, never the component's markup.
test("in a sentence, left carries the leave block between its first and second groups", async ({ page }) => {
  await sentence(page, "I left it there");
  const lines = (await blockLines(page, "left", "it")).map((l) => l.text);
  const first = lines.indexOf("sobrado, sobras");
  const via = lines.indexOf(formLine("viaInflectionWithEntry", "left", "leave"));
  const leaveVerb = lines.indexOf("dejar, abandonar, abjurar, apostatar, defeccionar, desertar, legar, partir, salir, irse, depositar, largarse");
  const leaveNoun = lines.indexOf("permiso, excedencia, licencia, despedida");
  const second = lines.indexOf("izquierda, de izquierda, izquierdo");
  const rest = lines.indexOf("a la izquierda, izquierdo");
  for (const [name, at] of Object.entries({ first, via, leaveVerb, leaveNoun, second, rest })) {
    expect(at, `${name} is in left's block`).toBeGreaterThanOrEqual(0);
  }
  expect(first, "left's first group leads").toBeLessThan(via);
  expect(via).toBeLessThan(leaveVerb);
  expect(leaveVerb).toBeLessThan(leaveNoun);
  expect(leaveNoun, "left's second group follows the whole leave block").toBeLessThan(second);
  expect(second).toBeLessThan(rest);
  expect(lines.filter((line) => line === formLine("viaInflectionWithEntry", "left", "leave")), "named once").toHaveLength(1);
  await expect(mainHeadings(page).filter({ hasText: /^leave$/ })).toHaveCount(1);
});

// The Done table says «see» before «serrar»; RL-58 says right under the form's
// first group, and the word page for `saw` answers serrar, then see, then
// sierra. This asserts RL-58 and the word page.
test("in a sentence, saw carries the see block under its first group, ahead of its second", async ({ page }) => {
  await sentence(page, "I saw it there");
  const lines = (await blockLines(page, "saw", "it")).map((l) => l.text);
  const serrar = lines.indexOf("serrar, aserrar");
  const via = lines.indexOf(formLine("viaInflectionWithEntry", "saw", "see"));
  const sierra = lines.indexOf("sierra, proverbio, refrán, dicho");
  expect(serrar).toBeGreaterThanOrEqual(0);
  expect(serrar, "the form's first group leads").toBeLessThan(via);
  expect(via, "the lemma block rises above the form's second group").toBeLessThan(sierra);
});

test("in a sentence, bed (an exact entry with no lemma) carries no lemma block", async ({ page }) => {
  await sentence(page, "I left it on the bed");
  const lines = (await blockLines(page, "bed", null)).map((l) => l.text);
  expect(lines.some((line) => line.includes("cama, lecho"))).toBe(true);
  expect(lines.filter((line) => line.includes("es una forma de"))).toEqual([]);
  await expect(mainHeadings(page).filter({ hasText: /^bed$/ })).toHaveCount(1);
});

test("in a sentence, a form with no entry of its own still leads, then names its lemma once", async ({ page }) => {
  await sentence(page, "stopping bed");
  const lines = (await blockLines(page, "stopping", "bed")).map((l) => l.text);
  const form = lines.indexOf(formLine("formOf", "stopping", "stop"));
  expect(form, "the form is named").toBeGreaterThanOrEqual(0);
  expect(lines.filter((line) => line.includes("también es una forma de"))).toEqual([]);
  expect(lines.indexOf("dejar de, parar de, parar, detener, pararse, entullecer, discontinuar")).toBeGreaterThan(form);
  await expect(mainHeadings(page).filter({ hasText: /^stop$/ })).toHaveCount(1);
});

// SinEntradaFuncionPlegadaOscuroMovil.
test("a function word's dictionary block is folded on arrival behind a control that says so", async ({ page }) => {
  await sentence(page, "it would be there");
  for (const word of ["it", "would", "be", "there"]) {
    const control = controlOf(page, word);
    await expect(control, `${word} has its control`).toHaveAttribute("aria-expanded", "false");
    await expect(control).toHaveText(FOLDED_LABEL);
  }
  await expect(visible(page, functionWordTranslation("would") as string), "the table line stays").toHaveCount(1);
  await expect(visible(page, "por favor"), "would's dictionary line is not on screen").toHaveCount(0);
  await expect(visible(page, messages.word.translations), "no group label of any word is on screen").toHaveCount(0);
});

test("the control is a 44px target", async ({ page }) => {
  await sentence(page, "it would be there");
  const box = await controlOf(page, "would").boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

test("tapping the control opens the muted block and the control reads «ocultar»; tapping again folds it", async ({ page }) => {
  await sentence(page, "it would be there");
  const control = controlOf(page, "would");
  await control.click();
  await expect(control).toHaveAttribute("aria-expanded", "true");
  await expect(control).toHaveText(OPEN_LABEL);
  await expect(visible(page, "por favor")).toHaveCount(1);
  await expect(controlOf(page, "be"), "another word stays folded").toHaveAttribute("aria-expanded", "false");
  await expect(visible(page, "ser, estar")).toHaveCount(1);

  const lines = await blockLines(page, "would", "be");
  const table = lines.find((l) => l.text === functionWordTranslation("would"));
  const opened = lines.find((l) => l.text === "por favor");
  expect(table).toBeDefined();
  expect(opened?.color, "the opened block is muted").not.toBe(table?.color);
  expect(lines.find((l) => l.text === messages.word.translations)?.color, "and so are its labels").not.toBe(table?.color);

  await control.click();
  await expect(control).toHaveAttribute("aria-expanded", "false");
  await expect(control).toHaveText(FOLDED_LABEL);
  await expect(visible(page, "por favor")).toHaveCount(0);
});

test("six function words at 360 take less than half of the 2540px the open breakdown measured", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 400, "the 2540px was measured at 360");
  const query = "that was what they could do";
  for (const word of query.split(" ")) {
    expect(functionWordTranslation(word), `${word} is in the table`).not.toBeNull();
  }
  await sentence(page, query);
  const [from, to] = await page.locator("main *").evaluateAll((nodes) => {
    const boxes = nodes
      .filter((node) => node.children.length === 0 && (node.textContent ?? "").trim() !== "")
      .map((node) => node.getBoundingClientRect());
    return [Math.min(...boxes.map((b) => b.top)), Math.max(...boxes.map((b) => b.bottom))];
  });
  expect(to - from).toBeLessThan(2540 / 2);
});

test("offline, a sentence still answers from the device: the lemma block under left's first group, the function words folded", async ({
  page,
  context,
}) => {
  await deleteTranslator(page);
  await openReady(page);
  await context.setOffline(true);
  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  await page.getByRole("textbox", { name: messages.search.label }).fill("I left it there");
  await expect(visible(page, formLine("viaInflectionWithEntry", "left", "leave"))).toHaveCount(1);
  const lines = (await blockLines(page, "left", "it")).map((l) => l.text);
  expect(lines.indexOf("sobrado, sobras")).toBeLessThan(lines.indexOf(formLine("viaInflectionWithEntry", "left", "leave")));
  expect(lines.indexOf(formLine("viaInflectionWithEntry", "left", "leave"))).toBeLessThan(lines.indexOf("izquierda, de izquierda, izquierdo"));

  await expect(controlOf(page, "it")).toHaveAttribute("aria-expanded", "false");
  await expect(visible(page, "tecnología de la información")).toHaveCount(0);
  await unfold(page, "it");
  await expect(visible(page, "tecnología de la información")).toHaveCount(1);

  await page.waitForTimeout(PHRASE_DEBOUNCE_MS + 300);
  expect(strayRequests(requestUrls).filter((url) => !url.includes("/api/translate"))).toEqual([]);
});

test("log.study.forms is gone from the messages", () => {
  expect(Object.keys(messages.log.study)).not.toContain("forms");
});
