import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";

// RP-16, the stylesheet's half: the `.partial` rules of `mark.module.css` and
// `week-table.module.css` paint the accent ring and lower half. No screen
// renders a partial yet, so this does not prove the primitives map the state
// to that class; the specs of the modules that consume it do.
type Painted = { image: string; ring: string; accent: string; backgroundColor: string };

// The classes of a state come from the primitive's own element: a hashed module class is
// `<prefix><name>`, so the prefix read off a real element's `name` class says which stylesheet
// holds the state's rule.
async function paint(page: Page, part: string, stateClass: string, base: string[]): Promise<Painted> {
  return page.evaluate(
    ({ part, stateClass, base }) => {
      const names = [...base, stateClass];
      const sample = [...document.querySelectorAll(`[data-part="${part}"]`)]
        .map((el) => [...el.classList].find((c) => c.endsWith(base[0]) && /[_]$/.test(c.slice(0, c.length - base[0].length))))
        .find(Boolean);
      if (!sample) throw new Error(`no [data-part="${part}"] element with a «${base[0]}» class`);
      const prefix = sample.slice(0, sample.length - base[0].length);
      const classes = names.map((name) => prefix + name);
      const defined = (cls: string) =>
        Array.from(document.styleSheets).some((sheet) =>
          Array.from(sheet.cssRules).some((rule) => new RegExp(`\\.${cls}(?![\\w-])`).test((rule as CSSStyleRule).selectorText ?? "")),
        );
      if (classes.some((c) => !defined(c))) throw new Error(`no class for ${names}`);
      const el = document.createElement("span");
      el.className = classes.join(" ");
      el.style.cssText = "display:inline-block;width:24px;height:24px;border-radius:50%";
      document.body.append(el);
      const cs = getComputedStyle(el);
      const out = {
        image: cs.backgroundImage,
        ring: cs.boxShadow,
        backgroundColor: cs.backgroundColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--pulsar-accent").trim(),
      };
      el.remove();
      return out;
    },
    { part, stateClass, base },
  );
}

const rgb = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

for (const scheme of ["light", "dark"] as const) {
  test(`the .partial CSS rules of mark and week dot paint the accent ring and lower half on ${scheme} (RP-16)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/semana");
    await expect(page.getByRole("table")).toBeVisible();

    const accent = await page.evaluate(() => {
      const probe = document.createElement("i");
      probe.style.color = "var(--pulsar-accent)";
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });

    const dot = {
      partial: await paint(page, "week-dot", "partial", ["dot"]),
      empty: await paint(page, "week-dot", "empty", ["dot"]),
      declared: await paint(page, "week-dot", "declared", ["dot"]),
      evidence: await paint(page, "week-dot", "evidence", ["dot"]),
    };
    // The lower half is the accent, the upper transparent; the ring is the accent.
    expect(dot.partial.image).toContain("linear-gradient");
    expect(dot.partial.image).toContain(accent);
    expect(dot.partial.image).toContain("to top");
    expect(dot.partial.ring).toContain(accent);
    // Pixels differ from the other states.
    for (const other of [dot.empty, dot.declared, dot.evidence]) {
      expect(`${dot.partial.image}|${dot.partial.ring}|${dot.partial.backgroundColor}`).not.toBe(
        `${other.image}|${other.ring}|${other.backgroundColor}`,
      );
    }
    // Every other state keeps its own style.
    expect(dot.empty.image).toBe("none");
    expect(dot.declared.image).toBe("none");
    expect(dot.declared.backgroundColor).toBe(accent);
    expect(dot.evidence.ring).toContain(accent);

    await page.goto("/");
    await expect(page.getByRole("main").first()).toBeVisible();
    const mark = {
      partial: await paint(page, "mark", "partial", ["mark", "ring"]),
      empty: await paint(page, "mark", "empty", ["mark", "ring"]),
      declared: await paint(page, "mark", "declared", ["mark"]),
      evidence: await paint(page, "mark", "evidence", ["mark", "ring"]),
    };
    expect(mark.partial.image).toContain("to top");
    expect(mark.partial.image).toContain(accent);
    expect(mark.partial.ring).toContain(accent);
    for (const other of [mark.empty, mark.declared, mark.evidence]) {
      expect(`${mark.partial.image}|${mark.partial.ring}|${mark.partial.backgroundColor}`).not.toBe(
        `${other.image}|${other.ring}|${other.backgroundColor}`,
      );
    }
    expect(mark.empty.image).toBe("none");
    expect(mark.declared.image).toBe("none");
    expect(mark.declared.backgroundColor).toBe(accent);
    expect(mark.evidence.ring).toContain(accent);
    expect(rgb(scheme === "light" ? "#1C6E5A" : "#4FBEA0")).toBe(accent);
  });
}
