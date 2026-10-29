import { expect, test } from "./fixtures";

import messages from "../messages/es.json";
import manifest from "../public/dictionary/manifest.json";

// The licence's own name is the link: `licenceName` is the catalog key the
// screen draws it from.
const licenceLinkText = messages.account.info.licenceName;

// Module 6 dropped `SourceNote`, the search screen's own link to `/fuente`
// (`components/search/source-note.tsx`), and nothing else in the app ever
// linked there. The credit's new home is `/cuenta`'s information tab
// (RL-33, successor of RL-15) — this spec now drives that destination.
test("RL-33: the credit, its source url and its edition are reachable from /cuenta with no session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as unknown as { Translator?: unknown }).Translator;
  });

  // No sign-in anywhere in this test: `/cuenta` renders signed out, and that
  // is what RL-33 leans on to keep the licence reachable by anyone.
  await page.goto("/cuenta");
  await expect(page.getByRole("heading", { name: messages.account.title })).toBeVisible();

  await page.getByRole("link", { name: messages.account.info.tabs.info }).click();

  // The dictionary's name doubles as the link to its source.
  const sourceLink = page.getByRole("link", { name: messages.account.info.dictionaryName });
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveAttribute("href", manifest.source.url);

  await expect(page.getByText(manifest.source.edition)).toBeVisible();

  const licenceLink = page.getByRole("link", { name: licenceLinkText });
  await expect(licenceLink).toBeVisible();
  await expect(licenceLink).toHaveAttribute("href", manifest.source.licenceUrl);
});

// RL-33 · RNL-02 · RNL-03: the Información tab writes figures the Spanish way
// and every credit is its own row, a 44 px touch target overlapping no other.
// Board `CuentaInformacionCreditos` (2026-10-08). Run at both widths whatever
// the project's own viewport, signed out.
const CREDIT_NAMES = [
  messages.account.info.licenceName,
  messages.account.info.frequencySource,
  messages.account.info.frequencyLicence,
];

const WIDTHS = [360, 1280];

for (const width of WIDTHS) {
  test.describe(`información at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(() => {
        delete (window as unknown as { Translator?: unknown }).Translator;
      });
      await page.goto("/cuenta");
      await page.getByRole("link", { name: messages.account.info.tabs.info }).click();
      await expect(page.getByText(manifest.source.edition)).toBeVisible();
    });

    test("the entry count carries the Spanish thousands separator", async ({ page }) => {
      const entries = new Intl.NumberFormat("es").format(manifest.counts.entries);
      const line = page.getByText(manifest.source.edition);
      await expect(line).toContainText(`${entries} entradas`);
      await expect(line).not.toContainText(`${manifest.counts.entries} entradas`);
    });

    test("the size is written with a decimal comma", async ({ page }) => {
      const mib = (manifest.asset.bytes / 1024 ** 2).toFixed(1).replace(".", ",");
      await expect(page.getByText(manifest.source.edition)).toContainText(
        `${mib} MiB en este dispositivo.`,
      );
    });

    test("each credit is a link of its own with a touch area of at least 44 px", async ({
      page,
    }) => {
      for (const name of CREDIT_NAMES) {
        const link = page.getByRole("link", { name, exact: true });
        await expect(link, `credit «${name}»`).toHaveCount(1);
        const box = await link.evaluate((a) => {
          const rects = [a, ...a.querySelectorAll("*")].map((e) => e.getBoundingClientRect());
          const left = Math.min(...rects.map((r) => r.left));
          const right = Math.max(...rects.map((r) => r.right));
          const top = Math.min(...rects.map((r) => r.top));
          const bottom = Math.max(...rects.map((r) => r.bottom));
          return { w: right - left, h: bottom - top };
        });
        expect(Math.min(box.w, box.h), `touch area of «${name}»`).toBeGreaterThanOrEqual(44);
      }
    });

    test("no two links on the tab have touch areas that intersect", async ({ page }) => {
      const links = page.locator("main a[href^='http']");
      const rects = await links.evaluateAll((as) =>
        as.map((a) => {
          const rs = [a, ...a.querySelectorAll("*")].map((e) => e.getBoundingClientRect());
          return {
            name: a.textContent ?? "",
            left: Math.min(...rs.map((r) => r.left)),
            right: Math.max(...rs.map((r) => r.right)),
            top: Math.min(...rs.map((r) => r.top)),
            bottom: Math.max(...rs.map((r) => r.bottom)),
          };
        }),
      );
      expect(rects.length).toBeGreaterThanOrEqual(CREDIT_NAMES.length + 1);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          expect(
            overlapX > 0.5 && overlapY > 0.5,
            `«${a.name}» overlaps «${b.name}»`,
          ).toBe(false);
        }
      }
    });

    test("the tab does not overflow sideways", async ({ page }) => {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });

    test("the two body paragraphs carry no link", async ({ page }) => {
      for (const body of [messages.account.info.licenceBody, messages.account.info.frequencyBody]) {
        const lead = body.split(".")[0];
        const paragraph = page.locator("p", { hasText: lead });
        await expect(paragraph, `paragraph «${lead}»`).toHaveCount(1);
        await expect(paragraph.locator("a")).toHaveCount(0);
        await expect(paragraph).toContainText(body.replace(/\s+/g, " ").slice(0, 40));
      }
    });

    test("each licence still links to its own source, signed out", async ({ page }) => {
      const hrefs = await Promise.all(
        CREDIT_NAMES.map((name) =>
          page.getByRole("link", { name, exact: true }).getAttribute("href"),
        ),
      );
      expect(hrefs[0]).toBe(manifest.source.licenceUrl);
      expect(hrefs[1]).toMatch(/^https:\/\//);
      expect(hrefs[2]).toMatch(/creativecommons\.org\/licenses\/by-nc-sa\/4\.0/);
    });
  });
}
