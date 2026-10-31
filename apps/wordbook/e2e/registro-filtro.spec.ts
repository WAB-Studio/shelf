import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import { DATABASE_VERSION } from "../lib/log/record";
import { expect, studyHeader, test } from "./fixtures";

// Module 704, RL-63 (and RL-56 for the forms line): /registro filters its
// rows by what is typed. Written from `private/despacho/704.md` and the
// approved boards RegistroFiltro{,Filtrando,Ninguna}OscuroMovil, not from the
// component. The copy is literal on purpose: the keys do not exist until the
// module lands, and a test reading `messages.log.study.filterLabel` would
// pass on `undefined`.
const LABEL = "Buscar en el registro";
const CLEAR = "Borrar el filtro";
const count = (shown: number, total: number) => `${shown} de ${total} palabras`;
const none = (query: string) => `Ninguna palabra con «${query}»`;

type SeedRow = {
  at: number;
  text: string;
  normalised: string;
  translation: string | null;
  headword?: string | null;
  outcome?: "exact" | "inflected";
};

async function deleteTranslator(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

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
              kind: "word",
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

// 800 words, 803 searches. Fillers are spelled from a-j only, so none holds
// «ling», «went» or «zzz» and no filler translation does either.
const WORDS = 800;
// The rows drawn before «Ver más» (`PAGE_ROWS` in history-list.tsx).
const FIRST_PAGE = 50;
const SEARCHES = 803;
const header = (page: Page, searches = SEARCHES, words = WORDS) => studyHeader(page, searches, words);

function fillerName(i: number): string {
  return "pal" + String(i).padStart(3, "0").replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);
}

function corpus(): SeedRow[] {
  const now = Date.now();
  const rows: SeedRow[] = [];
  for (let i = 0; i < WORDS - 4; i += 1) {
    const w = fillerName(i);
    rows.push({ at: now - 100000 + i, text: w, normalised: w, translation: "relleno" });
  }
  rows.push(
    { at: now - 90, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 80, text: "linger", normalised: "linger", translation: "demorar" },
    { at: now - 70, text: "lingered", normalised: "lingered", headword: "linger", outcome: "inflected", translation: "demorar" },
    { at: now - 60, text: "sibling", normalised: "sibling", translation: "hermano" },
    { at: now - 50, text: "go", normalised: "go", translation: "ir" },
    { at: now - 40, text: "went", normalised: "went", headword: "go", outcome: "inflected", translation: "ir" },
    { at: now - 30, text: "stay", normalised: "stay", translation: "permanecer" },
  );
  return rows;
}

async function open800(page: Page, url = "/registro"): Promise<void> {
  await deleteTranslator(page);
  await page.goto("/registro");
  await seedRows(page, corpus());
  await page.goto(url);
  await expect(header(page)).toBeVisible();
}

const rows = (page: Page) => page.locator('a[href^="/registro/"]');
const field = (page: Page) => page.getByRole("textbox", { name: LABEL });

test("loading: the skeleton shows and the filter field is absent", async ({ page }) => {
  await deleteTranslator(page);
  await page.addInitScript(() => {
    const real = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args: Parameters<typeof real>) {
      if (location.pathname === "/registro") return {} as IDBOpenDBRequest;
      return real.apply(this, args);
    };
  });
  await page.goto("/registro");
  await expect(page.getByText(messages.log.study.skeletonWord).first()).toBeVisible();
  await expect(field(page)).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("empty: the empty title shows and the filter field is absent", async ({ page }) => {
  await deleteTranslator(page);
  await page.addInitScript(() => {
    indexedDB.deleteDatabase("reading-log");
  });
  await page.goto("/registro");
  await expect(page.getByText(messages.log.study.emptyTitle)).toBeVisible();
  await expect(field(page)).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("failed: the failure shows and the filter field is absent", async ({ page }) => {
  await deleteTranslator(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          throw new Error("storage broken");
        },
      },
    });
  });
  await page.goto("/registro");
  await expect(page.getByText(messages.log.study.failedTitle)).toBeVisible();
  await expect(field(page)).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("ready with no text: the field is there, all 800 rows and today's header, no count line", async ({ page }) => {
  await open800(page);
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toHaveAttribute("placeholder", messages.log.study.filterPlaceholder);
  await expect(field(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
  await expect(page.getByText(/ de \d+ palabras/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: CLEAR })).toHaveCount(0);
});

test("typing «ling» leaves only the rows holding it and says «2 de 800 palabras»", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await expect(rows(page)).toHaveCount(2);
  const hrefs = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("href")).sort());
  expect(hrefs).toEqual(["/registro/linger", "/registro/sibling"]);
  await expect(page.getByText(count(2, WORDS), { exact: true })).toBeVisible();
  await expect(header(page)).toBeVisible();
});

test("typing a form that is not the key («went») leaves the row of its lemma «go»", async ({ page }) => {
  await open800(page);
  await field(page).fill("went");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('a[href="/registro/go"]')).toBeVisible();
  await expect(page.getByText(count(1, WORDS), { exact: true })).toBeVisible();
});

test("typing part of a translation («permane») leaves the row that carries it", async ({ page }) => {
  await open800(page);
  await field(page).fill("permane");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('a[href="/registro/stay"]')).toBeVisible();
});

test("no match («zzz»): the none line replaces the list, with no count line", async ({ page }) => {
  await open800(page);
  await field(page).fill("zzz");
  await expect(page.getByText(none("zzz"), { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText(/ de \d+ palabras/)).toHaveCount(0);
});

test("emptying the field brings back all 800 rows and drops the count line", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await expect(rows(page)).toHaveCount(2);
  await field(page).fill("");
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
  await expect(page.getByText(/ de \d+ palabras/)).toHaveCount(0);
});

test("the × button «Borrar el filtro» clears the field and restores the list", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await page.getByRole("button", { name: CLEAR }).click();
  await expect(field(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
  await expect(page.getByRole("button", { name: CLEAR })).toHaveCount(0);
});

test("the text lives in the URL: opening /registro?filtro=ling filters", async ({ page }) => {
  await open800(page, "/registro?filtro=ling");
  await expect(field(page)).toHaveValue("ling");
  await expect(rows(page)).toHaveCount(2);
  await field(page).fill("went");
  await expect(page).toHaveURL(/\/registro\?filtro=went$/);
});

test("going into a filtered row and back with «← Registro» finds «ling» and the same rows", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await expect(rows(page)).toHaveCount(2);
  await page.locator('a[href="/registro/linger"]').click();
  await expect(page).toHaveURL(/\/registro\/linger$/);
  await page.getByRole("link", { name: /← Registro/ }).click();
  await expect(page).toHaveURL(/\/registro/);
  await expect(field(page)).toHaveValue("ling");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByText(count(2, WORDS), { exact: true })).toBeVisible();
});

for (const event of ["voyager:sync-landed", "voyager:log-flushed"]) {
  test(`${event} with «ling» typed re-reads and re-filters, keeping the text`, async ({ page }) => {
    await open800(page);
    await field(page).fill("ling");
    await expect(rows(page)).toHaveCount(2);

    await seedRows(page, [{ at: Date.now(), text: "lingo", normalised: "lingo", translation: "jerga" }]);
    await page.evaluate((name) => window.dispatchEvent(new Event(name)), event);

    await expect(page.locator('a[href="/registro/lingo"]')).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    await expect(field(page)).toHaveValue("ling");
    await expect(page.getByText(count(3, WORDS + 1), { exact: true })).toBeVisible();
  });
}

test("offline: filtering still works and sends no request", async ({ page }) => {
  await open800(page);
  await page.context().setOffline(true);
  const requests: string[] = [];
  // Next's router prefetches the nav links when they enter the viewport; they land in the
  // window by timing alone and carry this header. Anything else the filter sends still counts.
  page.on("request", (r) => {
    if (r.headers()["next-router-prefetch"] === "1") return;
    requests.push(r.url());
  });
  await field(page).fill("ling");
  await expect(rows(page)).toHaveCount(2);
  await field(page).fill("zzz");
  await expect(page.getByText(none("zzz"), { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});

test("at 360px the field is at least 44px tall and nothing scrolls sideways, filtered or not", async ({ page }) => {
  await open800(page);
  const box = await field(page).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBe(0);
  await field(page).fill("ling");
  await expect(rows(page)).toHaveCount(2);
  expect(await overflow()).toBe(0);
  await field(page).fill("zzz");
  await expect(page.getByText(none("zzz"), { exact: true })).toBeVisible();
  expect(await overflow()).toBe(0);
});

test("each key of «ling» over 800 rows paints the filtered list in under 100 ms and never reads the lookups store again", async ({
  page,
}) => {
  await deleteTranslator(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __reads: number };
    w.__reads = 0;
    // Counts every transaction opened on `lookups`, whatever connection carries it.
    const real = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      stores: string | string[],
      ...rest: [IDBTransactionMode?, IDBTransactionOptions?]
    ) {
      const names = Array.isArray(stores) ? stores : [stores];
      if (names.includes("lookups")) w.__reads += 1;
      return real.call(this, stores, ...rest);
    } as typeof real;
  });
  await page.goto("/registro");
  await seedRows(page, corpus());
  await page.goto("/registro");
  await expect(header(page)).toBeVisible();
  await expect(field(page)).toBeVisible();

  const readsBefore = await page.evaluate(() => (window as unknown as { __reads: number }).__reads);
  const result = await page.evaluate(async () => {
    const input = document.querySelector("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const times: number[] = [];
    for (const prefix of ["l", "li", "lin", "ling"]) {
      const start = performance.now();
      setter.call(input, prefix);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      times.push(performance.now() - start);
    }
    // A re-read starts behind awaits; give it time to open its transaction.
    await new Promise((r) => setTimeout(r, 300));
    return {
      times,
      shown: document.querySelectorAll('a[href^="/registro/"]').length,
      reads: (window as unknown as { __reads: number }).__reads,
    };
  });
  expect(result.shown).toBe(2);
  expect(result.reads - readsBefore, "typing read the lookups store again").toBe(0);
  for (const ms of result.times) expect(ms).toBeLessThan(100);
});

test("the forms line of «linger» reads at 14px", async ({ page }) => {
  await open800(page);
  const line = page.getByText("linger, lingered", { exact: true });
  await expect(line).toBeVisible();
  expect(await line.evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
});

test("a list opened at /registro?filtro=ling: into a row and back with «← Registro» keeps «ling»", async ({ page }) => {
  await open800(page, "/registro?filtro=ling");
  await expect(rows(page)).toHaveCount(2);
  await page.locator('a[href="/registro/linger"]').click();
  await expect(page).toHaveURL(/\/registro\/linger$/);
  await page.getByRole("link", { name: /← Registro/ }).click();
  await expect(field(page)).toHaveValue("ling");
  await expect(rows(page)).toHaveCount(2);
});

for (const text of ["ice&fire", "50%", "a#b"]) {
  test(`a filter holding reserved characters («${text}») survives a reload and the round trip into a word and back`, async ({
    page,
  }) => {
    await open800(page);
    await seedRows(page, [{ at: Date.now(), text, normalised: text, translation: "reservado" }]);
    await page.reload();
    await expect(header(page, 804, 801)).toBeVisible();

    await field(page).fill(text);
    await expect(rows(page)).toHaveCount(1);

    await page.reload();
    await expect(field(page)).toHaveValue(text);
    await expect(rows(page)).toHaveCount(1);

    // Into the word and back by the links, without a reload losing the module's memory.
    await field(page).fill(text);
    await rows(page).first().click();
    await expect(page).toHaveURL(/\/registro\/./);
    await page.getByRole("link", { name: /← Registro/ }).click();
    await expect(field(page)).toHaveValue(text);
    await expect(rows(page)).toHaveCount(1);
  });
}

test("rows are cards: no hairline sits between them, filtered or not", async ({ page }) => {
  await open800(page, "/registro?filtro=ling");
  await expect(rows(page)).toHaveCount(2);
  const hairlines = (els: Element[]) =>
    els.map((el) => el.previousElementSibling?.classList.contains("rt-Separator") === true);
  expect(await rows(page).evaluateAll(hairlines)).toEqual([false, false]);
  await field(page).fill("");
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
  expect((await rows(page).evaluateAll(hairlines)).some(Boolean)).toBe(false);
});

test("typing only spaces filters nothing: all rows and no count line", async ({ page }) => {
  await open800(page);
  await field(page).fill("   ");
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
  await expect(page.getByText(/ de \d+ palabras/)).toHaveCount(0);
});

test("«zzz » with a trailing space names «zzz» in the none line", async ({ page }) => {
  await open800(page);
  await field(page).fill("zzz ");
  await expect(page.getByText(none("zzz"), { exact: true })).toBeVisible();
});

test("clearing the field leaves the address at exactly /registro", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await expect(page).toHaveURL(/\/registro\?filtro=ling$/);
  await field(page).fill("");
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
  expect(await page.evaluate(() => location.pathname + location.search + location.hash)).toBe("/registro");
});

test("the × button hands focus back to the filter field", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await page.getByRole("button", { name: CLEAR }).click();
  await expect(field(page)).toBeFocused();
  await expect(rows(page)).toHaveCount(FIRST_PAGE);
});

test("the × button pressed by key hands focus back to the filter field", async ({ page }) => {
  await open800(page);
  await field(page).fill("ling");
  await page.getByRole("button", { name: CLEAR }).focus();
  await page.keyboard.press("Enter");
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue("");
});

test("a filter typed on a bare /registro is kept: into a row and back with «← Registro» reads «ling»", async ({
  page,
}) => {
  await open800(page, "/registro");
  await expect(page).toHaveURL((url) => url.pathname === "/registro" && url.search === "");
  await field(page).fill("ling");
  await expect(rows(page)).toHaveCount(2);
  await rows(page).first().click();
  await expect(page).toHaveURL(/\/registro\/./);
  await page.getByRole("link", { name: /← Registro/ }).click();
  await expect(field(page)).toHaveValue("ling");
  await expect(rows(page)).toHaveCount(2);
});

test("a row opened in the same task as the last keystroke still brings the back link to «ling»", async ({ page }) => {
  await open800(page, "/registro");
  await expect(field(page)).toBeVisible();
  // Typing and the tap share one task, so the address has not been read back
  // into the page yet: only the typing itself can have kept the text.
  await field(page).evaluate((input: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "ling");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector('a[href^="/registro/"]') as HTMLAnchorElement).click();
  });
  await expect(page).toHaveURL(/\/registro\/./);
  await page.getByRole("link", { name: /← Registro/ }).click();
  await expect(field(page)).toHaveValue("ling");
  await expect(rows(page)).toHaveCount(2);
});
