import { expect, test } from "./fixtures";

import messages from "../messages/es.json";

// Runs against the `desktop` project alone (playwright.config.ts scopes it
// there): 1280x800, no touch. docs/wordbook/DESIGN.md "Viewport": the bar
// becomes a sidebar at 1024px, a second breakpoint distinct from the ~660px
// the reading column centres above.

const ROUTES = [
  { path: "/", key: "search" },
  { path: "/registro", key: "log" },
  { path: "/cuenta", key: "account" },
] as const;

async function disableTranslator(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });
}

test("one <nav> at the side on every route, never a bar at the foot", async ({ page }) => {
  await disableTranslator(page);

  for (const { path, key } of ROUTES) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // A single implementation, one media query: proven by count, not read
    // off the markup (docs/TRAPS.md "An unscoped locator finds both bands
    // at once" — a role locator already tells two trees from one).
    const navs = page.getByRole("navigation", { name: messages.nav.label });
    await expect(navs).toHaveCount(1);

    const box = await navs.boundingBox();
    expect(box).not.toBeNull();
    // Pinned to the left edge, spanning the full viewport height: a side
    // rail, never a short strip sitting at the foot.
    expect(box!.x).toBeLessThan(1);
    expect(box!.width).toBeGreaterThan(238);
    expect(box!.width).toBeLessThan(242);
    expect(box!.height).toBeGreaterThan(700);

    const current = navs.getByRole("link", { name: messages.nav[key] });
    await expect(current).toHaveAttribute("aria-current", "page");
    for (const other of ROUTES) {
      if (other.key === key) continue;
      await expect(navs.getByRole("link", { name: messages.nav[other.key] })).not.toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  }
});

test("from 1280px the main screen is a reading column and a 320px margin, both right of the sidebar", async ({ page }) => {
  await disableTranslator(page);
  // An answer keeps its margin; the empty screen draws one only once the record has a review to offer.
  await page.goto("/?q=throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  const navBox = await page.getByRole("navigation", { name: messages.nav.label }).boundingBox();
  const panels = await page.locator("main > div").first().boundingBox();
  const side = await page.locator("main aside").boundingBox();
  const field = await page.getByRole("textbox", { name: messages.search.label }).boundingBox();
  expect(navBox).not.toBeNull();
  expect(panels).not.toBeNull();
  expect(side).not.toBeNull();
  expect(field).not.toBeNull();

  // The sidebar's 240px and the page's 56px padding on both sides; the grid keeps 1104px at most.
  const room = viewport!.width - 240 - 112;
  expect(Math.abs(panels!.width - Math.min(1104, room))).toBeLessThan(2);
  expect(panels!.x).toBeGreaterThanOrEqual(navBox!.x + navBox!.width);
  expect(Math.abs(side!.width - 320)).toBeLessThan(1);
  expect(side!.x + side!.width).toBeLessThanOrEqual(panels!.x + panels!.width + 1);
  // The box lives in the reading column, left of the margin and 64px from it.
  expect(field!.x + field!.width).toBeLessThanOrEqual(side!.x - 63);
});

// `measure="full"` shipped with the 660px rule's `width: 100%` still in
// force under the 1024px rule that pushes it past the sidebar, so every one
// of these three routes scrolled sideways by exactly the sidebar's own
// 240px band. The suite was green: `escritorio.spec.ts` measured the
// reading column, and `full` is the other branch of the same stylesheet.
for (const route of ["/registro", "/registro/apple", "/cuenta"]) {
  test(`${route} takes the width left of the sidebar without scrolling the page sideways`, async ({ page }) => {
    await disableTranslator(page);
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBe(clientWidth);

    // Starts after the sidebar and ends at the viewport's own edge: the
    // width equality above passes just as well for a `main` that never
    // cleared the sidebar at all.
    const mainBox = await page.locator("main").boundingBox();
    expect(mainBox).not.toBeNull();
    expect(mainBox!.x).toBe(240);
    expect(Math.round(mainBox!.x + mainBox!.width)).toBe(viewport!.width);
  });
}

test("RL-97: at 1440px the sidebar sits left of the column, the margin right of it, and each sense has one learn button", async ({
  page,
}) => {
  await disableTranslator(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?q=throughout");
  await expect(page.getByRole("heading", { name: "throughout" })).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);

  const nav = await page.getByRole("navigation", { name: messages.nav.label }).boundingBox();
  const panels = await page.locator("main > div").first().boundingBox();
  const side = await page.locator("main aside").boundingBox();
  const searchBox = await page.getByRole("textbox", { name: messages.search.label }).boundingBox();
  const answer = await page.getByRole("heading", { name: "throughout" }).boundingBox();
  expect(nav).not.toBeNull();
  expect(panels).not.toBeNull();
  expect(side).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(answer).not.toBeNull();

  expect(nav!.x + nav!.width).toBeLessThanOrEqual(panels!.x);
  expect(Math.abs(panels!.x - (240 + 56))).toBeLessThan(2);
  expect(Math.abs(side!.width - 320)).toBeLessThan(1);
  for (const inner of [searchBox!, answer!]) {
    expect(inner.x).toBeGreaterThanOrEqual(panels!.x - 1);
    expect(inner.x + inner.width).toBeLessThanOrEqual(side!.x);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);

  // `throughout` has two senses: numbered, and one control on each, never two.
  const learn = page.getByRole("button", { name: new RegExp(`^(${messages.word.learnThisSense}|${messages.word.learningThisSense})$`) });
  await expect(learn).toHaveCount(2);
  await expect(page.getByText(/^1 · /)).toHaveCount(1);
  await expect(page.getByText(/^2 · /)).toHaveCount(1);

  // A word with one sense is not numbered and still has its one control.
  await page.goto("/?q=apple");
  await expect(page.getByRole("heading", { name: "apple" })).toBeVisible({ timeout: 10000 });
  await expect(learn).toHaveCount(1);
  await expect(page.getByText(/^\d+ · /)).toHaveCount(0);
});

test("RL-97: the panel of suggestions answers ↓, Enter and Esc", async ({ page }) => {
  await disableTranslator(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const field = page.getByRole("textbox", { name: messages.search.label });
  await field.fill("throu");

  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 10000 });
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");

  await field.press("Escape");
  await expect(options).toHaveCount(0);
  // The text is untouched, and typing again brings the panel back.
  await expect(field).toHaveValue("throu");
  await field.press("g");
  await expect(options.first()).toBeVisible();

  await field.press("ArrowDown");
  const word = (await options.nth(1).locator("span").nth(1).textContent())!.trim();
  await field.press("Enter");
  await expect(field).toHaveValue(word);
});

// Registro as one table by day and Repaso in a centred column (docs/wordbook/DESIGN.md
// "Registro y Repaso en escritorio", RL-98). The record and one card are written straight into
// the two databases, the way a reader's own searches and review would have left them.
async function seedDesk(page: import("@playwright/test").Page): Promise<void> {
  const now = Date.now();
  const rows = [
    { text: "throughout", translation: "de arriba abajo", at: now - 60_000 },
    { text: "reliable", translation: "confiable", at: now - 120_000 },
    { text: "though", translation: "aunque", at: now - 86_400_000 },
  ];
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await page.evaluate(
    ({ rows, now }) =>
      new Promise<void>((resolve, reject) => {
        const log = indexedDB.open("reading-log", 3);
        log.onupgradeneeded = () => {
          const store = log.result.createObjectStore("lookups", { keyPath: "id", autoIncrement: true });
          store.createIndex("at", "at");
          store.createIndex("normalised", "normalised");
          log.result.createObjectStore("sync", { keyPath: "key" });
          store.createIndex("foreign", ["device", "deviceSeq"], { unique: true });
          store.createIndex("headword", "headword");
        };
        log.onsuccess = () => {
          const tx = log.result.transaction("lookups", "readwrite");
          for (const row of rows) {
            tx.objectStore("lookups").add({
              schema: 4,
              at: row.at,
              text: row.text,
              normalised: row.text,
              kind: "word",
              outcome: "exact",
              headword: row.text,
              rule: null,
              senses: 1,
              translation: row.translation,
              dictionaryReady: true,
              origin: null,
            });
          }
          tx.oncomplete = () => {
            log.result.close();
            const review = indexedDB.open("reading-review", 3);
            review.onupgradeneeded = () => {
              for (const name of ["cards", "senses", "gone", "meta"]) {
                if (!review.result.objectStoreNames.contains(name)) review.result.createObjectStore(name, { keyPath: "key" });
              }
            };
            review.onsuccess = () => {
              const put = review.result.transaction("cards", "readwrite");
              put.objectStore("cards").put({
                key: "throughout",
                due: now + 3 * 86_400_000,
                stability: 3,
                difficulty: 5,
                scheduledDays: 3,
                learningSteps: 0,
                reps: 2,
                lapses: 0,
                state: 2,
                lastReview: now - 86_400_000,
                introducedOn: "2026-11-18",
              });
              put.oncomplete = () => {
                review.result.close();
                resolve();
              };
              put.onerror = () => reject(put.error);
            };
          };
          tx.onerror = () => reject(tx.error);
        };
        log.onerror = () => reject(log.error);
      }),
    { rows, now },
  );
}

test("at 1440px Registro is one table by day with its column names, and a row's menu removes the word", async ({ page }) => {
  await disableTranslator(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedDesk(page);
  await page.goto("/registro");

  const table = page.getByRole("table", { name: messages.log.study.tableLabel });
  await expect(table).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(1);
  for (const column of ["columnWord", "columnTranslation", "columnState", "columnTimes", "columnTime"] as const) {
    await expect(table.getByRole("columnheader", { name: messages.log.study[column], exact: true })).toBeVisible();
  }
  // Two days, newest first: «Hoy · 2» then «Ayer · 1».
  const days = table.getByRole("rowheader");
  await expect(days).toHaveCount(2);
  await expect(days.nth(0)).toHaveText(/^Hoy · 2$/i);
  await expect(days.nth(1)).toHaveText(/^Ayer · 1$/i);
  // A learning word says so; a word with no card draws a dash.
  const throughout = table.getByRole("row").filter({ has: page.locator('a[href="/registro/throughout"]') });
  await expect(throughout.getByRole("cell", { name: messages.log.study.stateLearning, exact: true })).toBeVisible();
  expect(Math.round((await throughout.locator("> div").first().boundingBox())!.height)).toBe(52);

  // The header carries the download menu and the review, and no figures or chips are left.
  await expect(page.getByRole("button", { name: messages.log.study.downloadMenu, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Repasar 2$/ })).toBeVisible();

  await page.getByRole("button", { name: `Más acciones de «reliable»` }).click();
  await page.getByRole("menuitem", { name: messages.log.study.removeRow }).click();
  await page.getByRole("button", { name: messages.log.study.deleteConfirm, exact: true }).or(
    page.getByRole("link", { name: messages.log.study.deleteConfirm, exact: true }),
  ).click();
  await expect(page.locator('a[href="/registro/reliable"]')).toHaveCount(0);
  await expect(page.locator('a[href="/registro/throughout"]')).toBeVisible();
});

test("at 1440px the review is one 680px column centred in what the sidebar leaves", async ({ page }) => {
  await disableTranslator(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedDesk(page);
  await page.goto("/repaso");
  await expect(page.getByRole("button", { name: messages.review.show })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const card = await page.locator("main section").first().boundingBox();
  expect(card).not.toBeNull();
  // The content area runs from the sidebar's 240px to the viewport's edge: 1200px, centre at 840.
  expect(Math.abs(card!.x + card!.width / 2 - 840)).toBeLessThan(2);
  expect(Math.abs(card!.width - 680)).toBeLessThan(2);

  await page.getByRole("button", { name: messages.review.show }).click();
  const grades = page.getByRole("button", { name: /^(Otra vez|Difícil|Bien|Fácil)/ });
  await expect(grades).toHaveCount(4);
  const boxes = await grades.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
  for (const box of boxes) expect(Math.round(box.height)).toBe(64);
  expect(Math.abs(boxes[0].width - boxes[3].width)).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
});
