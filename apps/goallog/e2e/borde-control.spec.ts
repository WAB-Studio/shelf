import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { test, expect, settled } from "./fixtures";

// Module 57 (docs/goallog/DESIGN.md "Tokens"): a Field, a TextArea and an unselected Chip draw `--pulsar-control-edge`
// at 3:1 against their ground, a card keeps `--pulsar-border`, and no readable word is set in `quiet`.

const FACES = ["light", "dark"] as const;
const EDGE = { light: "rgb(138, 147, 158)", dark: null } as const;

function token(page: Page, name: string): Promise<string> {
  return page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

function luminance(css: string): number {
  const [r, g, b] = css.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const face of FACES) {
  test.describe(`${face} face`, () => {
    test.use({ colorScheme: face });

    test("a Field, a TextArea and an unselected Chip draw the control edge, and it reads 3:1", async ({ page }) => {
      await page.goto("/metas/nueva");
      await settled(page);
      const edge = await token(page, "--pulsar-control-edge");
      const raised = await token(page, "--pulsar-raised");
      if (EDGE[face]) expect(edge).toBe(EDGE[face]);
      expect(ratio(edge, raised), `edge ${edge} on ${raised}`).toBeGreaterThanOrEqual(3);

      const field = await page.locator("input").first().locator("xpath=ancestor::*[contains(@class,'rt-TextFieldRoot')][1]").evaluate((el) => getComputedStyle(el).boxShadow);
      expect(field).toContain(edge);

      await page.goto("/metas/importar");
      await settled(page);
      const area = await page.locator("textarea").first().evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(area).toBe(edge);

    });

    test("every word on the forms reads at 4.5:1 against its ground", async ({ page }) => {
      for (const path of ["/metas/nueva", "/metas/importar"]) {
        await page.goto(path);
        await settled(page);
        const low = await page.evaluate(() => {
          const channels = (css: string) => css.match(/[\d.]+/g)!.map(Number);
          const lum = ([r, g, b]: number[]) => {
            const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
          };
          const ground = (el: Element): number[] => {
            for (let n: Element | null = el; n; n = n.parentElement) {
              const c = channels(getComputedStyle(n).backgroundColor);
              if (c.length === 3 || c[3] > 0.99) return c;
            }
            return [255, 255, 255];
          };
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("main *")) {
            const own = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").trim());
            if (!own || el.getClientRects().length === 0 || (el as HTMLInputElement).disabled) continue;
            const a = lum(channels(getComputedStyle(el).color));
            const b = lum(ground(el));
            const r = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (r < 4.5) out.push(`${(el.textContent ?? "").trim().slice(0, 30)} ${r.toFixed(2)}`);
          }
          return out;
        });
        expect(low, path).toEqual([]);
      }
    });

    test("the card's own border stays --pulsar-border", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/metas/importar");
      await settled(page);
      const border = await token(page, "--pulsar-border");
      const edge = await token(page, "--pulsar-control-edge");
      expect(border).not.toBe(edge);
      const colors = await page.evaluate(() =>
        [...document.querySelectorAll("main *")].map((el) => getComputedStyle(el).borderTopColor + "|" + getComputedStyle(el).borderTopWidth),
      );
      expect(colors.some((c) => c.startsWith(border) && !c.endsWith("|0px"))).toBe(true);
    });
  });
}

test("a chip not chosen draws the control edge", async ({ page }) => {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(`Meta borde ${Date.now()}`);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL("**/compromisos/nuevo");
  await settled(page);
  const edge = await token(page, "--pulsar-control-edge");
  const chips = page.getByRole("button", { pressed: false });
  expect(await chips.count()).toBeGreaterThan(0);
  expect(await chips.first().evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(edge);
});

// The import row's meta lines and the plan tables' dates are source-level facts: reaching a review row needs a whole import.
test("no readable word is set in quiet", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  expect(read("components/ui/check-row.tsx")).not.toMatch(/tone=(\{[^}]*)?"quiet"/);
  expect(read("components/ui/check-row.tsx")).toMatch(/variant="meta" tone="muted"/);
  expect(read("components/day/quantity-sheet.tsx")).not.toContain('"quiet"');
  expect(read("components/ui/text.tsx")).not.toContain("quiet:");
  const table = read("components/ui/table.module.css");
  for (const cls of [".detail", ".detailWide"]) {
    const body = table.slice(table.indexOf(`${cls} {`), table.indexOf("}", table.indexOf(`${cls} {`)));
    expect(body, cls).toContain("var(--pulsar-muted)");
  }
});
