import type { Page } from "@playwright/test";

import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// `MetasCentro` and `MetasCentroEscritorio` (RP-49, RP-37, RNP-07):
// «el plan» is outline cards, each with its title on one line and its hint
// under it, 12px apart.

async function expectPlanCards(page: Page, names: string[], width: number) {
  const boxes: { top: number; bottom: number }[] = [];
  for (const name of names) {
    const link = page.getByRole("link", { name: new RegExp(`^${name}`) });
    await expect(link).toBeVisible();
    // The title is the link's first text: its own line boxes, not the card's.
    const card = await link.evaluate((el, label) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.includes(label)) node = walker.nextNode();
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const rect = range.getBoundingClientRect();
      const hint = el.querySelector("p, span, div");
      const own = el.getBoundingClientRect();
      return {
        lines: tops.size,
        height: rect.height,
        lineHeight: parseFloat(getComputedStyle(node.parentElement!).lineHeight),
        titleBottom: rect.bottom,
        hintTop: hint ? hint.getBoundingClientRect().top : null,
        hintWeight: hint ? getComputedStyle(hint).fontWeight : null,
        top: own.top,
        bottom: own.bottom,
      };
    }, name);
    const at = `${name} at ${width}`;
    expect(card, at).not.toBeNull();
    expect(card!.lines, `${at} lines`).toBe(1);
    expect(card!.height, `${at} height`).toBeLessThanOrEqual(card!.lineHeight + 1);
    // The hint sits under the title, never beside it.
    expect(card!.hintTop, `${at} hint`).not.toBeNull();
    expect(card!.hintTop!, `${at} hint under title`).toBeGreaterThanOrEqual(card!.titleBottom - 1);
    expect(card!.hintWeight, `${at} hint weight`).toBe("400");
    expect(card!.bottom - card!.top, `${at} card height`).toBeGreaterThanOrEqual(52);
    boxes.push({ top: card!.top, bottom: card!.bottom });
  }
  for (let i = 1; i < boxes.length; i += 1) {
    expect(Math.abs(boxes[i].top - boxes[i - 1].bottom - 12), `gap before ${names[i]} at ${width}`).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test("with a goal, the plan cards keep one-line titles, hints under them and 12px between, at 360, 1024 and 1440; «Abrir otra meta» stays centred", async ({
  person,
  browser,
  db,
}) => {
  const horizon = civilDateToDate(todayInZone());
  horizon.setUTCDate(horizon.getUTCDate() + 60);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Meta del plan', ${dateToCivilDate(horizon)}, now() - interval '5 days')
    returning id
  `;
  try {
    for (const width of [360, 1024, 1440]) {
      const context = await browser.newContext({
        storageState: person.sessionFile,
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.goto("/metas");
        await expectPlanCards(page, ["Importar un plan", "Exportar", "Conectar una IA"], width);

        const another = page.getByRole("link", { name: "Abrir otra meta" });
        await expect(another).toBeVisible();
        const centres = await another.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const label = range.getBoundingClientRect();
          const own = el.getBoundingClientRect();
          return { label: label.left + label.width / 2, own: own.left + own.width / 2 };
        });
        expect(Math.abs(centres.label - centres.own), `«Abrir otra meta» centre at ${width}`).toBeLessThanOrEqual(2);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});

test("with no goal, «Importar un plan» and «Conectar una IA» keep the same cards at 360 and 1440", async ({
  person,
  browser,
}) => {
  for (const width of [360, 1440]) {
    const context = await browser.newContext({
      storageState: person.sessionFile,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/metas");
      await expectPlanCards(page, ["Importar un plan", "Conectar una IA"], width);
    } finally {
      await context.close();
    }
  }
});
