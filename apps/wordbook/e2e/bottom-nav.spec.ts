import { afterFrames, expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// The screen is on the page: its main region is there, its fonts are in and
// the browser has laid it out.
async function drawn(page: Page): Promise<void> {
  await expect(page.locator("main")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await afterFrames(page);
}

// A readwrite transaction on `lookups` opens only once every write queued
// before it has committed, so its completion says the log has settled.
async function writesSettled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("lookups", "readwrite");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        };
      }),
  );
}

// docs/wordbook/DESIGN.md "Viewport": the bar every board draws.
test("the bottom bar carries Buscar and Registro, and each reaches its route", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  await page.goto("/");
  await drawn(page);

  const nav = page.getByRole("navigation", { name: messages.nav.label });
  const buscar = nav.getByRole("link", { name: messages.nav.search });
  const registro = nav.getByRole("link", { name: messages.nav.log });

  // Both items render, nowhere else in the page duplicates their name — the
  // search box itself also answers to "Buscar", so this counts the nav alone.
  await expect(buscar).toBeVisible();
  await expect(registro).toBeVisible();

  // RNL-03's 44px floor, DESIGN.md's own widening of it for this bar —
  // measured on the rendered box, not read off a class name.
  for (const item of [buscar, registro]) {
    const box = await item.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  }

  // On `/`, Buscar is the current section.
  await expect(buscar).toHaveAttribute("aria-current", "page");
  await expect(registro).not.toHaveAttribute("aria-current", "page");

  await registro.click();
  await expect(page).toHaveURL(/\/registro$/);
  await expect(page.getByRole("navigation", { name: messages.nav.label }).getByRole("link", { name: messages.nav.log })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByRole("navigation", { name: messages.nav.label }).getByRole("link", { name: messages.nav.search }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("navigation", { name: messages.nav.label }).getByRole("link", { name: messages.nav.search })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // RNL-03: the bar itself never forces horizontal scroll at the phone
  // viewport this project runs.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBe(clientWidth);
});

// `/fuente` was this non-section page until module 10 (RL-33) retired it.
// `/registro/[palabra]` replaces it: a real route the bar's own `items`
// never lists (only the bare `/registro` marks Registro current, `pathname
// === route`), and no other lane's assignment holds it right now.
test("the bar carries neither section as current on a page that isn't one", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  await page.goto("/registro/zzqqxv");
  await drawn(page);

  const nav = page.getByRole("navigation", { name: messages.nav.label });
  // A word page is not a section (DESIGN.md "Viewport"): the bar still
  // renders, reachable from it, but neither item is the current one.
  await expect(nav.getByRole("link", { name: messages.nav.search })).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: messages.nav.log })).not.toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: messages.nav.log }).click();
  await expect(page).toHaveURL(/\/registro$/);
});

test("Buscar carries the query past a trip through Registro, unretyped", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  await page.goto("/?q=book");
  await assetResponse;
  // aria-busy turns false once the worker has built its index and the install is done.
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();

  const nav = () => page.getByRole("navigation", { name: messages.nav.label });
  await nav().getByRole("link", { name: messages.nav.log }).click();
  await expect(page).toHaveURL(/\/registro$/);

  await nav().getByRole("link", { name: messages.nav.search }).click();
  await expect(page).toHaveURL(/\?q=book$/);
  await expect(page.getByRole("textbox", { name: messages.search.label })).toHaveValue("book");
});

test("all three routes still draw the bar at 360px, with no horizontal overflow", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  for (const route of ["/", "/registro", "/cuenta"]) {
    await page.goto(route);
    await drawn(page);

    const nav = page.getByRole("navigation", { name: messages.nav.label });
    const box = await nav.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    // The bar, not the sidebar: it sits in the viewport's lower half.
    expect(box!.y).toBeGreaterThan(viewport!.height / 2);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBe(clientWidth);
  }
});

test("Buscar reaches a bare / with nothing to remember", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  await page.goto("/registro");
  await drawn(page);

  const buscar = page.getByRole("navigation", { name: messages.nav.label }).getByRole("link", { name: messages.nav.search });
  await expect(buscar).toHaveAttribute("href", "/");
});

// The bar is what makes this reachable: "Buscar" returns to `/?q=<word>`,
// the URL keeps the query, and the search screen remounts and answers it
// again. Answering again is right; recording it again is not — a reader who
// walks to the log and back three times looked the word up once. Found by
// reading a real book, where that round trip is constant.
test("returning through the bar does not record the restored query again", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  const assetResponse = page.waitForResponse(
    (response) => response.url().includes(manifest.asset.path) && response.ok(),
  );
  // Opened at the query, the state a reader is in once they have looked a
  // word up: the bar reads the address bar into its own memory at mount.
  await page.goto("/?q=manures");
  await assetResponse;
  // aria-busy turns false once the worker has built its index and the install is done.
  await expect(page.locator('[aria-busy="false"]').first()).toBeAttached();

  const nav = () => page.getByRole("navigation", { name: messages.nav.label });
  for (let trip = 0; trip < 3; trip += 1) {
    await nav().getByRole("link", { name: messages.nav.log }).click();
    await expect(page).toHaveURL(/\/registro$/);
    await nav().getByRole("link", { name: messages.nav.search }).click();
    await expect(page).toHaveURL(/q=manures/);
    // The answer on screen is what hands the row to the log; the barrier
    // waits out the write it started.
    await expect(page.getByRole("heading", { name: "manure", exact: true })).toBeVisible();
    await writesSettled(page);
  }

  // One last trip away forces the final flush, then settle before counting.
  // A polled `toBe(1)` is wrong here: rows land one flush at a time, so it
  // passes on the transient first row and never sees the duplicates arrive
  // behind it — it wins a race against its own data.
  await nav().getByRole("link", { name: messages.nav.log }).click();
  await expect(page).toHaveURL(/\/registro$/);
  await writesSettled(page);

  const rows: Array<{ normalised: string }> = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("reading-log");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const getAll = request.result.transaction("lookups", "readonly").objectStore("lookups").getAll();
          getAll.onsuccess = () => resolve(getAll.result);
          getAll.onerror = () => reject(getAll.error);
        };
      }),
  );

  const manures = rows.filter((row) => row.normalised === "manures");
  expect(manures, "three round trips record the word once, not four times").toHaveLength(1);
});

// RNL-03 / docs/wordbook/DESIGN.md "Viewport": the bar's labels are 11px / 600 /
// 0.12em / uppercase and read as one even run of letters at both widths — the
// bar at 360 and the side rail at 1280 draw the same `<span>`.
const LABEL_WIDTHS = [360, 1280] as const;

type LabelMeasure = {
  text: string;
  fontSize: string;
  fontWeight: string;
  letterSpacing: string;
  textTransform: string;
  whiteSpace: string;
  lineTops: number[];
  // Pen advance of every letter as drawn, letter-spacing taken out.
  drawn: number[];
  // The same letters at 1100px (hinting cannot round anything there), /100:
  // what the font itself says each letter is worth at 11px.
  designed: number[];
};

async function measureLabels(page: import("@playwright/test").Page): Promise<LabelMeasure[]> {
  return page.evaluate(async () => {
    await document.fonts.load('600 11px "IBM Plex Sans"');
    await document.fonts.ready;
    const nav = document.querySelector("nav");
    if (!nav) throw new Error("no nav");
    const labels = [...nav.querySelectorAll("a span")].filter((span) => span.children.length === 0 && span.textContent);
    return labels.map((label) => {
      const style = getComputedStyle(label);
      const spacing = parseFloat(style.letterSpacing) || 0;
      const text = label.firstChild as Text;
      const boxes: DOMRect[] = [];
      for (let i = 0; i < text.length; i += 1) {
        const range = document.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        boxes.push(range.getBoundingClientRect());
      }
      const ruler = document.createElement("span");
      ruler.textContent = text.data.toUpperCase();
      ruler.style.cssText = `position:absolute;white-space:nowrap;font-family:${style.fontFamily};font-weight:${style.fontWeight};font-size:1100px;letter-spacing:0;text-rendering:geometricPrecision`;
      document.body.appendChild(ruler);
      const big = ruler.firstChild as Text;
      const designed: number[] = [];
      for (let i = 0; i < big.length; i += 1) {
        const range = document.createRange();
        range.setStart(big, i);
        range.setEnd(big, i + 1);
        designed.push(range.getBoundingClientRect().width / 100);
      }
      ruler.remove();
      return {
        text: text.data,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        textTransform: style.textTransform,
        whiteSpace: style.whiteSpace,
        lineTops: [...new Set(boxes.map((box) => Math.round(box.top)))],
        drawn: boxes.map((box) => box.width - spacing),
        designed,
      };
    });
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

for (const width of LABEL_WIDTHS) {
  test.describe(`bar labels at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        delete (window as unknown as { Translator?: unknown }).Translator;
      });
      await page.setViewportSize({ width, height: 740 });
      await page.goto("/registro");
      await drawn(page);
    });

    test("no letter pair opens a gap wider than the label's own median", async ({ page }) => {
      const labels = await measureLabels(page);
      expect(labels.map((label) => label.text)).toEqual([messages.nav.search, messages.nav.log, messages.nav.account]);

      for (const label of labels) {
        expect(label.drawn).toHaveLength(label.text.length);
        // The space after letter i is the spacing plus whatever the letter
        // was drawn wider than the font designed it; spacing is constant, so
        // the excess is what can open a gap. The last letter has no neighbour.
        const excess = label.drawn.slice(0, -1).map((drawn, i) => drawn - label.designed[i]);
        const base = median(excess);
        excess.forEach((value, i) => {
          expect.soft(
            value - base,
            `${label.text}: letter ${label.text[i]} is drawn ${value.toFixed(2)}px wider than designed, the label's median is ${base.toFixed(2)}px`,
          ).toBeLessThanOrEqual(1);
        });
      }
    });

    test("labels keep 11px / 600 / 0.12em / uppercase", async ({ page }) => {
      for (const label of await measureLabels(page)) {
        expect(label.fontSize, label.text).toBe("11px");
        expect(label.fontWeight, label.text).toBe("600");
        expect(label.letterSpacing, label.text).toBe("1.32px");
        expect(label.textTransform, label.text).toBe("uppercase");
      }
    });

    test("each label stays on one line", async ({ page }) => {
      for (const label of await measureLabels(page)) {
        expect(label.lineTops, `${label.text} letters sit on ${label.lineTops.length} lines`).toHaveLength(1);
        expect(label.whiteSpace, label.text).toBe("nowrap");
      }
    });
  });
}

test("RNL-03: at 360px no control overlaps another, at the top or the foot of each route", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  for (const route of ["/?q=throughout", "/registro", "/cuenta"]) {
    await page.goto(route);
    await drawn(page);
    await page.locator('[aria-busy="false"]').first().waitFor({ state: "attached" });

    for (const edge of ["top", "foot"] as const) {
      if (edge === "foot") await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await afterFrames(page);
      // Each control on screen is the topmost element at its own centre, and
      // no two controls share pixels unless one holds the other.
      const clashes = await page.evaluate(() => {
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => {
          if (!el.checkVisibility()) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
        });
        const name = (el: HTMLElement) => `${el.tagName} «${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}»`;
        const found: string[] = [];
        for (const el of controls) {
          const r = el.getBoundingClientRect();
          const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
          const y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
          const hit = document.elementFromPoint(x, y);
          if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) found.push(`${name(el)} under ${hit.tagName}`);
        }
        for (const [i, a] of controls.entries()) {
          for (const b of controls.slice(i + 1)) {
            if (a.contains(b) || b.contains(a)) continue;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (w > 1 && h > 1) found.push(`${name(a)} overlaps ${name(b)}`);
          }
        }
        return found;
      });
      expect(clashes, `${route} at its ${edge}`).toEqual([]);
    }
  }
});
