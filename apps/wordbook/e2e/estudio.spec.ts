import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { DATABASE_VERSION } from "../lib/log/record";

// The module 7 done criterion: `/registro` groups by word, orders by
// frequency, folds case into one row, and links each row to its own
// history (RL-32's first half — the second is `palabra-historial.spec.ts`).

// Chromium's built-in `Translator` hangs `availability()` forever
// (docs/TRAPS.md); the word path here must never reach it.
async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

type SeedRow = {
  at: number;
  text: string;
  normalised: string;
  translation: string | null;
  // The headword the search reached; defaults to `normalised` (an exact hit).
  headword?: string | null;
  outcome?: "exact" | "inflected" | "unlisted" | "translated";
  kind?: "word" | "phrase";
};

// Raw IndexedDB, mirroring `lib/log/record.ts`'s own shape — this runs
// inside `page.evaluate`, a browser context no Node import reaches.
async function seedRows(page: Page, rows: SeedRow[]): Promise<void> {
  await page.evaluate(
    ({ rows, version }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log", version);
        request.onupgradeneeded = (event) => {
          const database = request.result;
          if (event.oldVersion < 1) {
            const store = database.createObjectStore("lookups", { keyPath: "id", autoIncrement: true });
            store.createIndex("at", "at");
            store.createIndex("normalised", "normalised");
          }
          if (event.oldVersion < 2) {
            database.createObjectStore("sync", { keyPath: "key" });
            request.transaction!
              .objectStore("lookups")
              .createIndex("foreign", ["device", "deviceSeq"], { unique: true });
          }
          if (event.oldVersion < 3) {
            request.transaction!.objectStore("lookups").createIndex("headword", "headword");
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("lookups", "readwrite");
          const store = tx.objectStore("lookups");
          for (const row of rows) {
            store.add({
              schema: 2,
              at: row.at,
              text: row.text,
              normalised: row.normalised,
              kind: row.kind ?? "word",
              outcome: row.outcome ?? "exact",
              headword: row.headword === undefined ? row.normalised : row.headword,
              rule: null,
              senses: 1,
              translation: row.translation,
              dictionaryReady: true,
              origin: null,
            });
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { rows, version: DATABASE_VERSION },
  );
}

test("three lukewarm and a Word fold into two rows, lukewarm first, Word never its own row", async ({ page }) => {
  await deleteTranslator(page);
  // No `deleteLogDatabase` here: it is an init script, so it would also fire
  // on the `reload()` below and erase the rows just seeded. A fresh
  // Playwright context already starts with no `reading-log` of its own.

  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 5000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
    { at: now - 4000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
    { at: now - 3000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
    // The capitalised search is the older of the two: the newer, lowercase
    // one is what the fold's own `newer` branch (summary.ts:33) should show.
    { at: now - 2000, text: "Word", normalised: "word", translation: "palabra" },
    { at: now - 1000, text: "word", normalised: "word", translation: "palabra" },
  ]);
  await page.reload();

  const rows = page.locator('a[href^="/registro/"]');
  await expect(rows).toHaveCount(2);

  const texts = await rows.allInnerTexts();
  expect(texts[0]).toContain("lukewarm");
  expect(texts[0]).toContain("3");
  expect(texts[1]).toContain("word");
  expect(texts[1]).toContain("2");

  // The literal string "Word" never draws as its own row's text: the fold
  // resolved the group's display to the most recent search, "word".
  await expect(page.getByText("Word", { exact: true })).toHaveCount(0);
});

test("tapping a row from /registro reaches that word's own history", async ({ page }) => {
  await deleteTranslator(page);

  await page.goto("/registro");
  await seedRows(page, [{ at: Date.now(), text: "lukewarm", normalised: "lukewarm", translation: "tibio" }]);
  await page.reload();

  await page.locator('a[href="/registro/lukewarm"]').click();
  await expect(page).toHaveURL(/\/registro\/lukewarm$/);
});

// The dictionary's own longest headword, no space anywhere in it — the same
// literal string `word.spec.ts:157` already proves the search screen holds
// at 360px, so a row's own clamp is measured against the exact case that
// broke it, not a stand-in.
const LONGEST_HEADWORD = "Taumatawhakatangihangakoauauotamateaturipukakapikimaungahoronukupokaiwhenuakitanatahu";

test("a row's headword with no space to break on never scrolls the page sideways, at 360px", async ({ page }) => {
  await deleteTranslator(page);

  await page.goto("/registro");
  await seedRows(page, [
    { at: Date.now(), text: LONGEST_HEADWORD, normalised: LONGEST_HEADWORD.toLowerCase(), translation: "tibio" },
  ]);
  await page.reload();

  await expect(page.locator(`a[href="/registro/${LONGEST_HEADWORD.toLowerCase()}"]`)).toBeVisible();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBe(clientWidth);
});

// RL-56 / board `RegistroFormasComasOscuroMovil`. The forms line is every
// searched form, most searched first, separated by commas and nothing else.
// A line is found by being exactly that list; a row's other lines are the
// lemma, the translations and the count.
function formsLineOf(text: string, ...forms: string[]): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => forms.some((f) => l.split(", ").includes(f)) && !/^\d+$/.test(l));
}

function formsOf(line: string): string[] {
  return line.split(", ").map((f) => f.trim());
}

async function rowText(page: Page, href: string): Promise<string> {
  return page.locator(`a[href="${href}"]`).innerText();
}

test("a lemma and its inflected forms are one row: both forms under it, the count of all of them", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 6000, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 5000, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 4000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 3000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 2000, text: "lingering", normalised: "lingering", headword: "linger", outcome: "inflected", translation: "demorar" },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(1);
  await expect(page.locator('a[href="/registro/linger"]')).toBeVisible();
  await expect(page.locator('a[href="/registro/lingered"]')).toHaveCount(0);

  const text = await rowText(page, "/registro/linger");
  expect(text).toMatch(/\b5\b/);
  const line = formsLineOf(text, "lingered");
  expect(line).toBeDefined();
  expect(line!).not.toContain("·");
  expect(formsOf(line!).sort()).toEqual(["linger", "lingered", "lingering"]);
});

test("a form searched under another lemma shows in that lemma's row: «left» and «leave» under leave", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 4000, text: "left", normalised: "left", headword: "leave", outcome: "inflected", translation: "dejar" },
    { at: now - 3000, text: "left", normalised: "left", headword: "leave", outcome: "inflected", translation: "dejar" },
    { at: now - 2000, text: "leave", normalised: "leave", translation: "dejar" },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(1);
  const text = await rowText(page, "/registro/leave");
  expect(text).toMatch(/\b3\b/);
  // left ×2, leave ×1: the most searched leads.
  expect(formsLineOf(text, "left")).toBe("left, leave");
});

test("a lemma searched under one spelling only draws no forms line", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 2000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
    { at: now - 1000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
  ]);
  await page.reload();

  const text = await rowText(page, "/registro/lukewarm");
  expect(text).toContain("tibio");
  expect(text).not.toContain("·");
});

test("the row opens the lemma's page, /registro/linger, never a form's", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 2000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 1000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
  ]);
  await page.reload();

  // Only the inflected form was ever typed: the row is still the lemma's.
  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(1);
  await page.locator('a[href="/registro/linger"]').click();
  await expect(page).toHaveURL(/\/registro\/linger$/);
});

test("a miss and a phrase each keep their own row, beside a lemma's", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  const phrase = "I left my house yesterday morning";
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 5000, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 4000, text: "asdkjh", normalised: "asdkjh", headword: null, outcome: "unlisted", translation: null },
    { at: now - 3000, text: phrase, normalised: phrase.toLowerCase(), headword: null, kind: "phrase", outcome: "translated", translation: "Dejé mi casa ayer por la mañana" },
    { at: now - 2000, text: phrase, normalised: phrase.toLowerCase(), headword: null, kind: "phrase", outcome: "translated", translation: "Dejé mi casa ayer por la mañana" },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(3);
  const rows = await page.locator('a[href^="/registro/"]').allInnerTexts();
  const miss = rows.find((t) => t.includes("asdkjh"));
  expect(miss).toMatch(/\b1\b/);
  const phraseRow = rows.find((t) => t.includes(phrase));
  expect(phraseRow).toMatch(/\b2\b/);
  expect(phraseRow).toContain("Dejé mi casa");
  // The lemma row does not swallow either of them.
  const lemmaRow = rows.find((t) => t.includes("demorar") && !t.includes(phrase));
  expect(lemmaRow).not.toContain("asdkjh");
});

test("a search with no result says «sin resultado» in its own row", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await seedRows(page, [
    { at: Date.now(), text: "asdkjh", normalised: "asdkjh", headword: null, outcome: "unlisted", translation: null },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(1);
  expect(await page.locator('a[href^="/registro/"]').innerText()).toContain("sin resultado");
});

test("rows order by the count of the whole lemma, ties broken by the most recent search", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    // walk: 3 searches over three forms, none of them 3 alone.
    { at: now - 9000, text: "walk", normalised: "walk", translation: "caminar" },
    { at: now - 8900, text: "walked", normalised: "walked", headword: "walk", outcome: "inflected", translation: "caminar" },
    { at: now - 8800, text: "walking", normalised: "walking", headword: "walk", outcome: "inflected", translation: "caminar" },
    // zeta: 2 searches of one spelling — more than any single walk form.
    { at: now - 7000, text: "zeta", normalised: "zeta", translation: "zeta" },
    { at: now - 6000, text: "zeta", normalised: "zeta", translation: "zeta" },
    // zeta, alpha and beta tie at 2; the most recent search leads: beta, alpha, zeta.
    { at: now - 5000, text: "alpha", normalised: "alpha", translation: "alfa" },
    { at: now - 4000, text: "alpha", normalised: "alpha", translation: "alfa" },
    { at: now - 3000, text: "beta", normalised: "beta", translation: "beta" },
    { at: now - 1000, text: "beta", normalised: "beta", translation: "beta" },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(4);
  const hrefs = await page.locator('a[href^="/registro/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(["/registro/walk", "/registro/beta", "/registro/alpha", "/registro/zeta"]);
});

test("the header counts every search and one word per lemma", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 4000, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 3000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 2000, text: "lingering", normalised: "lingering", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 1000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
  ]);
  await page.reload();

  await expect(page.getByText("4 búsquedas · 2 palabras.")).toBeVisible();
});

test("the forms line lists the most searched form first, a tie to the most recent", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 9000, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 8000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 7000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 6000, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    // walk: three forms, each once; the most recent leads, the oldest trails.
    { at: now - 5000, text: "walked", normalised: "walked", headword: "walk", outcome: "inflected", translation: "caminar" },
    { at: now - 3000, text: "walking", normalised: "walking", headword: "walk", outcome: "inflected", translation: "caminar" },
    { at: now - 4000, text: "walks", normalised: "walks", headword: "walk", outcome: "inflected", translation: "caminar" },
  ]);
  await page.reload();

  const linger = await rowText(page, "/registro/linger");
  expect(formsLineOf(linger, "lingered")).toBe("lingered, linger");
  const walk = await rowText(page, "/registro/walk");
  expect(formsLineOf(walk, "walking")).toBe("walking, walks, walked");
  expect(linger + walk).not.toContain(" · ");
});

test("a row whose only searched form is its key names it once", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 2000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
    { at: now - 1000, text: "lukewarm", normalised: "lukewarm", translation: "tibio" },
  ]);
  await page.reload();

  const text = await rowText(page, "/registro/lukewarm");
  expect(text.match(/lukewarm/g)).toHaveLength(1);
});

// RL-56: a row's title is the lemma when the search reached one, the text as
// typed when it reached none (a phrase, a miss).
async function titleOf(page: Page, href: string): Promise<string> {
  const text = await rowText(page, href);
  return text.split("\n")[0]!.trim();
}

test("a row reached through an inflected search is titled with the lemma, not the text typed", async ({ page }) => {
  await deleteTranslator(page);
  const now = Date.now();
  await page.goto("/registro");
  await seedRows(page, [
    { at: now - 2000, text: "Lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 1000, text: "Lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(1);
  expect(await titleOf(page, "/registro/linger")).toBe("linger");
});

test("a miss keeps the text as typed for its title", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await seedRows(page, [
    { at: Date.now(), text: "Blorpt", normalised: "blorpt", headword: null, outcome: "unlisted", translation: null },
  ]);
  await page.reload();

  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(1);
  expect(await titleOf(page, "/registro/blorpt")).toBe("Blorpt");
});

test("a lemma reached by one inflected form alone still names that form in its row", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await seedRows(page, [
    { at: Date.now(), text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
  ]);
  await page.reload();

  const lines = (await rowText(page, "/registro/linger")).split("\n");
  expect(lines[0]!.trim()).toBe("linger");
  expect(lines.slice(1).some((l) => l.includes("lingered"))).toBe(true);
});

// The board, row by row, at both widths. Seeded counts: linger 9 (lingered 4,
// linger 3, lingering 2), lukewarm 7, leave 6 (left 4, leave 2), serendipity
// 4, go 2 (went 2).
for (const viewport of [
  { width: 360, height: 950 },
  { width: 1280, height: 800 },
]) {
  test.describe(`RegistroFormasComas at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("each row's forms line is comma-separated, most searched first, and absent when it says nothing new", async ({ page }) => {
      await deleteTranslator(page);
      const now = Date.now();
      let n = 0;
      const rows: SeedRow[] = [];
      const add = (count: number, row: Omit<SeedRow, "at">) => {
        for (let i = 0; i < count; i++) rows.push({ ...row, at: now - 100000 + n++ * 10 });
      };
      const inflected = { outcome: "inflected" as const };
      add(4, { text: "lingered", normalised: "lingered", headword: "linger", ...inflected, translation: "demorar" });
      add(3, { text: "linger", normalised: "linger", translation: "demorar" });
      add(2, { text: "lingering", normalised: "lingering", headword: "linger", ...inflected, translation: "demorar" });
      add(7, { text: "lukewarm", normalised: "lukewarm", translation: "tibio" });
      add(4, { text: "left", normalised: "left", headword: "leave", ...inflected, translation: "dejar" });
      add(2, { text: "leave", normalised: "leave", translation: "dejar" });
      add(4, { text: "serendipity", normalised: "serendipity", translation: "casualidad" });
      add(2, { text: "went", normalised: "went", headword: "go", ...inflected, translation: "ir" });
      await page.goto("/registro");
      await seedRows(page, rows);
      await page.reload();

      await expect(page.locator('a[href="/registro/linger"]')).toBeVisible();
      const linger = await rowText(page, "/registro/linger");
      expect(formsLineOf(linger, "lingered")).toBe("lingered, linger, lingering");
      expect(linger).not.toContain(" · ");

      const leave = await rowText(page, "/registro/leave");
      expect(formsLineOf(leave, "left")).toBe("left, leave");

      // One form, another than the key: it is named, alone.
      const go = await rowText(page, "/registro/go");
      expect(formsLineOf(go, "went")).toBe("went");

      // One form, the key: no forms line, the word appears once.
      for (const key of ["lukewarm", "serendipity"]) {
        const text = await rowText(page, `/registro/${key}`);
        expect(text.match(new RegExp(key, "g"))).toHaveLength(1);
        expect(text).not.toContain("·");
      }

      expect(await page.locator("body").innerText()).not.toContain(" · lingered");
    });
  });
}

test("no searches at all draws the empty state, no rows", async ({ page }) => {
  await deleteTranslator(page);
  await page.goto("/registro");
  await expect(page.getByText("Todavía no has buscado nada")).toBeVisible();
  await expect(page.locator('a[href^="/registro/"]')).toHaveCount(0);
});
