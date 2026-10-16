import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// `search-screen.tsx`'s own constant, not exported: the debounce a sentence
// waits out before it is worth asking about (RNL-05, rule 1). Shared with
// `phrase.spec.ts`'s own copy of the same literal, not imported from it.
const PHRASE_DEBOUNCE_MS = 600;

async function waitForDictionary(page: Page): Promise<void> {
  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/");
  await assetResponse;
  await page.waitForTimeout(1000);
}

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); deleting it routes every sentence over the network,
// which is the path every test in this file drives.
async function disableDeviceTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

async function stubTranslateRoute(page: Page, answers: Record<string, string>): Promise<void> {
  await page.route("**/api/translate", async (route) => {
    const { text } = route.request().postDataJSON() as { text: string };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: answers[text], origin: "network" }),
    });
  });
}

type NotesAnswer = { notes: Array<{ term: string; note: string }>; delayMs: number };

// A page-level route: Playwright checks it before the context-level one
// `fixtures.ts` installs, so a source sentence here carries its own timed
// answer instead of the fixture's default 204. `x-e2e-word-stub` is the
// same header `fixtures.ts` stamps on its own stub — set here too, so its
// escape watchdog reads this as an answered stub, not a call that reached
// a real paid model.
async function stubNotesRoute(page: Page, answers: Record<string, NotesAnswer>): Promise<{ count: () => number }> {
  let count = 0;
  await page.route("**/api/phrase/notes", async (route) => {
    count++;
    const { source } = route.request().postDataJSON() as { source: string };
    const answer = answers[source];
    if (answer.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-e2e-word-stub": "1" },
      body: JSON.stringify({ notes: answer.notes }),
    });
  });
  return { count: () => count };
}

test("the translation paints whole before its notes ever answer", async ({ page }) => {
  await disableDeviceTranslator(page);
  const phraseText = "black minorca pullets";
  const answerText = "pollitas negras de menorca";
  const noteBody = "Es una raza de gallina de color negro.";

  await stubTranslateRoute(page, { [phraseText]: answerText });
  await stubNotesRoute(page, {
    [phraseText]: { notes: [{ term: "black minorca", note: noteBody }], delayMs: 1200 },
  });
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(phraseText);

  // The translation is already whole...
  await expect(page.getByText(answerText)).toBeVisible({ timeout: 5000 });
  // ...and at this exact point the notes have not answered yet: waiting,
  // not a note in sight.
  await expect(page.getByText(messages.phrase.notesPending)).toBeVisible();
  await expect(page.getByText(messages.phrase.notesTitle)).toHaveCount(0);
  await expect(page.getByText(noteBody)).toHaveCount(0);

  // Only once the delayed answer actually lands does the note appear.
  await page.waitForTimeout(1300);
  await expect(page.getByText(messages.phrase.notesTitle)).toBeVisible();
  await expect(page.getByText("black minorca", { exact: true })).toBeVisible();
  await expect(page.getByText(noteBody)).toBeVisible();
});

test("changing the phrase while its notes are in flight never paints the old phrase's notes", async ({ page }) => {
  await disableDeviceTranslator(page);
  const staleText = "black minorca pullets";
  const staleAnswer = "pollitas negras de menorca";
  const staleNoteBody = "Es una raza de gallina de color negro.";
  const freshText = "frisking from side to side";
  const freshAnswer = "correteando de lado a lado";

  await stubTranslateRoute(page, { [staleText]: staleAnswer, [freshText]: freshAnswer });
  await stubNotesRoute(page, {
    [staleText]: { notes: [{ term: "black minorca", note: staleNoteBody }], delayMs: 1500 },
    [freshText]: { notes: [], delayMs: 0 },
  });
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(staleText);
  await expect(page.getByText(staleAnswer)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.phrase.notesPending)).toBeVisible();

  // A fresh sentence, typed while the first phrase's notes are still on
  // their way.
  await searchBox.fill(freshText);
  await expect(page.getByText(freshAnswer)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(messages.phrase.notesTitle)).toHaveCount(0);

  // The stale request is still in flight; give it time to land and prove
  // it never displaces what is already shown.
  await page.waitForTimeout(1700);
  await expect(page.getByText(staleNoteBody)).toHaveCount(0);
  await expect(page.getByText(staleAnswer)).toHaveCount(0);
  await expect(page.getByText(freshAnswer)).toBeVisible();
});

test("a phrase whose notes answer 204 reads exactly as the screen did before RL-46", async ({ page }) => {
  await disableDeviceTranslator(page);
  const phraseText = "we drove to the coast together";
  const answerText = "condujimos juntos hasta la costa";
  await stubTranslateRoute(page, { [phraseText]: answerText });
  // No stubNotesRoute call: `fixtures.ts`'s own default answers
  // `/api/phrase/notes` with 204, the same default every other spec relies
  // on, so this test drives the real fixture path rather than a fake of it.
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(phraseText);

  await expect(page.getByText(answerText)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(phraseText)).toBeVisible();
  await expect(page.getByText(messages.phrase.originNetwork)).toBeVisible();

  // Give the notes fetch time to settle before reading its absence: a
  // 204 this fast never has anything to paint either way.
  await page.waitForTimeout(500);
  await expect(page.getByText(messages.phrase.notesTitle)).toHaveCount(0);
  await expect(page.getByText(messages.phrase.notesPending)).toHaveCount(0);
});

test("a keystroke mid-phrase raises no request to /api/phrase/notes", async ({ page }) => {
  await disableDeviceTranslator(page);
  const phraseText = "frisking from side to side";
  const answerText = "correteando de lado a lado";
  await stubTranslateRoute(page, { [phraseText]: answerText });
  // Default 204 from `fixtures.ts` again: this test only counts requests,
  // never their answer.

  let notesRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/phrase/notes")) notesRequests++;
  });

  await waitForDictionary(page);
  const searchBox = page.getByRole("textbox", { name: messages.search.label });

  // One keystroke short of the full phrase, well inside the debounce
  // window: no translation exists yet for anything to note.
  await searchBox.fill(phraseText.slice(0, -1));
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS - 100);
  expect(notesRequests, "no notes request before any translation is even asked for").toBe(0);

  // The keystroke that completes the phrase — still short of the debounce
  // that would let a translation request leave at all.
  await searchBox.fill(phraseText);
  await page.waitForTimeout(PHRASE_DEBOUNCE_MS - 100);
  expect(notesRequests, "the completing keystroke itself raises nothing").toBe(0);

  await expect(page.getByText(answerText)).toBeVisible({ timeout: 5000 });
  // The fixture's default 204 answers fast enough that the pending line can
  // already be gone by the time this reads — the request count below is
  // what this test is actually about, not the pending line's own lifespan.
  await expect
    .poll(() => notesRequests, { message: "the one request leaves only once the translation is already done" })
    .toBe(1);
});

// ---- RL-46 / RNL-05: notes are asked once per translation, never per keystroke ----

type Translate = { text: string; status?: number; delayMs?: number };

// Every call is recorded in order; `answer` decides each reply from the
// text and from how many times that text was already asked for.
async function stubTranslateCalls(
  page: Page,
  answer: (text: string, nth: number) => Translate,
): Promise<{ texts: string[] }> {
  const texts: string[] = [];
  await page.route("**/api/translate", async (route) => {
    const { text } = route.request().postDataJSON() as { text: string };
    const nth = texts.filter((asked) => asked === text).length;
    texts.push(text);
    const reply = answer(text, nth);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (reply.status && reply.status !== 200) {
      await route.fulfill({ status: reply.status, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: reply.text, origin: "network" }),
    });
  });
  return { texts };
}

// The `request` event, not the route handler: a request the page aborts
// mid-flight still counts, which is what spending the cap looks like. The
// answer stays `fixtures.ts`'s default 204, so no paid route is ever reached.
function recordNotes(page: Page): Array<{ source: string; translation: string }> {
  const bodies: Array<{ source: string; translation: string }> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/phrase/notes") {
      bodies.push(request.postDataJSON() as { source: string; translation: string });
    }
  });
  return bodies;
}

const SETTLE_MS = 1200;
const PHRASE = "frisking from side to side";
const PHRASE_ES = "correteando de lado a lado";

test("a phrase typed key by key is translated once and noted once", async ({ page }) => {
  await disableDeviceTranslator(page);
  const translations = await stubTranslateCalls(page, () => ({ text: PHRASE_ES }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.pressSequentially(PHRASE, { delay: 40 });
  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MS);

  expect(translations.texts, "a debounce turns the keys into one translation").toEqual([PHRASE]);
  expect(notes, "one translation owes exactly one notes request").toEqual([
    { source: PHRASE, translation: PHRASE_ES },
  ]);
});

test("typing after a translation raises no notes request until the next translation lands", async ({ page }) => {
  await disableDeviceTranslator(page);
  await stubTranslateCalls(page, (text) => ({ text: text === PHRASE ? PHRASE_ES : "otra traduccion nueva" }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(PHRASE);
  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  await expect.poll(() => notes.length).toBe(1);

  // Five keys, each well inside the debounce, and a read before it ends.
  await searchBox.pressSequentially(" more", { delay: 40 });
  await page.waitForTimeout(300);
  expect(notes, "keys after a translation spend nothing").toHaveLength(1);

  // The settled phrase is a new translation: one more request, with its own text.
  await expect(page.getByText("otra traduccion nueva")).toBeVisible({ timeout: 5000 });
  await expect.poll(() => notes.length).toBe(2);
  await page.waitForTimeout(SETTLE_MS);
  expect(notes).toEqual([
    { source: PHRASE, translation: PHRASE_ES },
    { source: `${PHRASE} more`, translation: "otra traduccion nueva" },
  ]);
});

test("returning to a phrase already translated and noted raises no request", async ({ page }) => {
  await disableDeviceTranslator(page);
  const other = "a quite different sentence";
  await stubTranslateCalls(page, (text) => ({ text: text === PHRASE ? PHRASE_ES : "una frase distinta" }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(PHRASE);
  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  await searchBox.fill(other);
  await expect(page.getByText("una frase distinta")).toBeVisible({ timeout: 5000 });
  await expect.poll(() => notes.length).toBe(2);

  await searchBox.fill(PHRASE);
  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(SETTLE_MS);
  expect(notes, "the same source with the same translation is already answered").toHaveLength(2);
});

test("the same phrase with another translation asks again", async ({ page }) => {
  test.setTimeout(90_000);
  await disableDeviceTranslator(page);
  // Past `PHRASE_CACHE_LIMIT` (20) the screen forgets the first translation
  // and asks for it afresh; the second answer differs.
  await stubTranslateCalls(page, (text, nth) => ({
    text: text === PHRASE ? (nth === 0 ? PHRASE_ES : "saltando de un lado a otro") : `filler ${text}`,
  }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(PHRASE);
  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  for (let index = 0; index < 21; index++) {
    const filler = `filler sentence number ${index}`;
    await searchBox.fill(filler);
    await expect(page.getByText(`filler ${filler}`)).toBeVisible({ timeout: 5000 });
  }
  await expect.poll(() => notes.length).toBe(22);

  await searchBox.fill(PHRASE);
  await expect(page.getByText("saltando de un lado a otro")).toBeVisible({ timeout: 5000 });
  await expect.poll(() => notes.length).toBe(23);
  expect(notes[22]).toEqual({ source: PHRASE, translation: "saltando de un lado a otro" });
});

test("no notes request while the translation is pending", async ({ page }) => {
  await disableDeviceTranslator(page);
  await stubTranslateCalls(page, () => ({ text: PHRASE_ES, delayMs: 1500 }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill(PHRASE);
  await expect(page.getByText(messages.phrase.translating)).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(800);
  expect(notes, "nothing to note while the translation is still out").toHaveLength(0);

  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  await expect.poll(() => notes.length).toBe(1);
});

test("no notes request when the translation fails", async ({ page }) => {
  await disableDeviceTranslator(page);
  const translations = await stubTranslateCalls(page, () => ({ text: "", status: 502 }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  await page.getByRole("textbox", { name: messages.search.label }).fill(PHRASE);
  await expect.poll(() => translations.texts.length).toBe(1);
  await page.waitForTimeout(SETTLE_MS);
  expect(notes).toHaveLength(0);
});

test("emptying the box after a translation raises no notes request", async ({ page }) => {
  await disableDeviceTranslator(page);
  await stubTranslateCalls(page, () => ({ text: PHRASE_ES }));
  const notes = recordNotes(page);
  await waitForDictionary(page);

  const searchBox = page.getByRole("textbox", { name: messages.search.label });
  await searchBox.fill(PHRASE);
  await expect(page.getByText(PHRASE_ES)).toBeVisible({ timeout: 5000 });
  await expect.poll(() => notes.length).toBe(1);

  await searchBox.fill("");
  await page.waitForTimeout(SETTLE_MS);
  expect(notes).toHaveLength(1);
  await expect(page.getByText(PHRASE_ES)).toHaveCount(0);
});
