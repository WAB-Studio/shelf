import { test, expect } from "./fixtures";
import { PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import { monthLabel } from "./sin-final-seed";
import {
  budget,
  expectInOrder,
  keysFor,
  mainLower,
  monthName,
  open,
  paperOf,
  rowMonths,
  sectionOf,
  seeAll,
  yOf,
} from "./mes-siguiente-seed";
import { aloneRe, anyOfRe, horizonIn, lineWords, ofRe, seedLeer, seedMudanza, seedPiano, seedTerminada } from "./por-mes-de-n-seed";
import { monthStartOf } from "./sin-final-seed";

import type { Locator, Page } from "@playwright/test";
import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Module 965, RP-118 (RP-116's successor), boards PorMesDeN and VerMenos. A list that folds says «{drawn} de {the goal's months} meses»
// on «Por mes», on the report and on paper; the whole list (`?todo=1`) says its one number; a goal with no end or of 12 months or fewer reads
// as before. Examples N1–N6 of plan s7. The contract: private/plan-pulsar-s7-2026-10-14.md `## 965`.
// Every month is an offset from the day the server reads, so a spec runs under any PULSAR_CLOCK.

test.use({ actionTimeout: 6000 });

const seeLess = (scope: Page | Locator) => scope.getByRole("link", { name: "ver menos", exact: true });
const textOfSection = async (section: Locator) => (await section.innerText()).replace(/\s+/g, " ").toLowerCase();
const reportOf = async (page: Page, name: string) => {
  await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  return sectionOf(page, name);
};

for (const width of [360, 1280]) {
  test.describe(`RP-118 «Por mes» at ${width}`, () => {
    test("N1: ten years ahead says «2 de 120 meses» over its two rows, the line and «ver todo», and no «ver menos»", async ({ person, browser, baseURL, db }) => {
      // Kills: counting `goal.months.length` of the rows drawn («2 meses», 5383eefa); drawing «ver menos» on a folded list.
      const id = await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const main = page.locator("main");
        expect(await rowMonths(page, id)).toEqual(keysFor([0, 1]));
        const lower = await mainLower(page);
        expect(lower).toMatch(ofRe(2, 120));
        expect(lower).not.toMatch(aloneRe(2));
        await expect(main.getByText(lineWords(118, 119)).locator("visible=true")).toBeVisible();
        await expect(seeAll(main)).toBeVisible();
        await expect(seeLess(main)).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

    for (const [tag, total, shown, seed] of [
      ["N2: a goal with an end of 27 months", 27, 13, async (db: Db, person: Person) => seedLeer(db, person, { endsIn: 3 })],
      [
        "N3: the same with December set to 60 (33 months, 14 drawn)",
        33,
        14,
        async (db: Db, person: Person) => {
          const id = await seedLeer(db, person, { endsIn: 9 });
          await budget(db, person, id, 2, 60);
          return id;
        },
      ],
      ["N4: a goal with no unit and 15 months", 15, 2, async (db: Db, person: Person) => seedMudanza(db, person)],
    ] as const) {
      test(`${tag} says «${shown} de ${total} meses»`, async ({ person, browser, baseURL, db }) => {
        // Kills: N = the rows of the first table (the count of the rows drawn, never the goal's months).
        const id = await seed(db, person);
        const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
        try {
          const lower = await mainLower(page);
          expect(lower).toMatch(ofRe(shown, total));
          expect(lower).not.toMatch(aloneRe(shown));
        } finally {
          await context.close();
        }
      });
    }

    test("N5: an ended goal of 20 months says «12 de 20 meses»", async ({ person, browser, baseURL, db }) => {
      // Kills: N = the rows of the first table; leaving the ended goal without a «de».
      const { id } = await seedTerminada(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, width);
      try {
        const lower = await mainLower(page);
        expect(lower).toMatch(ofRe(12, 20));
        expect(lower).not.toMatch(aloneRe(12));
      } finally {
        await context.close();
      }
    });

    test("N1 with `?todo=1`: «120 meses» alone, no «de», no line", async ({ person, browser, baseURL, db }) => {
      // Kills: «de N» drawn with `all`.
      const id = await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses?todo=1`, width);
      try {
        await expect(page.locator("main a[href*='/meses/']").first()).toBeVisible();
        const lower = await mainLower(page);
        expect(lower).toMatch(aloneRe(120));
        expect(lower).not.toMatch(anyOfRe);
        expect(lower).not.toMatch(/meses más/);
      } finally {
        await context.close();
      }
    });

    test("N6: a goal with no end says its rows alone («14 meses»), a goal of 3 months says «3 meses»", async ({ person, browser, baseURL, db }) => {
      // Kills: «de N» on every folded list; «de N» on every goal with an end.
      const free = await seedLeer(db, person, { endsIn: null });
      await budget(db, person, free, 2, 60);
      const short = await seedOpenGoal(db, person, { name: "Correr 10 km", unit: PAGES, horizon: horizonIn(2), rhythm: 40, created: openedOnDay(1).at });
      const a = await open(browser, baseURL, person.sessionFile, `/metas/${free}/meses`, width);
      try {
        const lower = await mainLower(a.page);
        expect(lower).toMatch(aloneRe(14));
        expect(lower).not.toMatch(anyOfRe);
      } finally {
        await a.context.close();
      }
      const b = await open(browser, baseURL, person.sessionFile, `/metas/${short}/meses`, width);
      try {
        const lower = await mainLower(b.page);
        expect(lower).toMatch(aloneRe(3));
        expect(lower).not.toMatch(anyOfRe);
      } finally {
        await b.context.close();
      }
    });
  });

  test.describe(`RP-118 the report at ${width}`, () => {
    test("N1 and N3: the card says the same «de N» as «Por mes»", async ({ person, browser, baseURL, db }) => {
      // Kills: the report counting `goal.months.length` of the drawn rows instead of the goal's months.
      await seedPiano(db, person);
      const leer = await seedLeer(db, person, { endsIn: 9 });
      await budget(db, person, leer, 2, 60);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        expect(await textOfSection(await reportOf(page, "Piano"))).toMatch(ofRe(2, 120));
        expect(await textOfSection(await reportOf(page, "Leer"))).toMatch(ofRe(14, 33));
      } finally {
        await context.close();
      }
    });

    test("N1 with `?todo=1`: «120 meses», no «de»", async ({ person, browser, baseURL, db }) => {
      // Kills: «de N» with `all` on the report.
      await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar?todo=1", width);
      try {
        const text = await textOfSection(await reportOf(page, "Piano"));
        expect(text).toMatch(aloneRe(120));
        expect(text).not.toMatch(anyOfRe);
      } finally {
        await context.close();
      }
    });

    test("S1: the report of N1 (no closed month hidden, 118 months out) draws «ver todo» to `/exportar?todo=1`", async ({ person, browser, baseURL, db }) => {
      // Kills: `cut.seeAll` → `cut.hidden > 0` on the report (survivor S1 of s6).
      await seedPiano(db, person);
      const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", width);
      try {
        const section = await reportOf(page, "Piano");
        await expect(seeAll(section)).toBeVisible();
        const href = (await seeAll(section).getAttribute("href")) ?? "";
        expect(href).toContain("/exportar");
        expect(href).toContain("todo=1");
      } finally {
        await context.close();
      }
    });
  });
}

test("Fix 3: the table of the report of N2 at 1280 has «planeado» in its header", async ({ person, browser, baseURL, db }) => {
  // Kills: the wide face dropping the «planeado» column header (validator s5, Fix 3).
  await seedLeer(db, person, { endsIn: 3 });
  const { page, context } = await open(browser, baseURL, person.sessionFile, "/exportar", 1280);
  try {
    const section = await reportOf(page, "Leer");
    await expect(section.getByRole("columnheader", { name: /planeado/i }).locator("visible=true").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Fix 1: an ended goal of 8 months opens «Por mes» at 1280 on its last month", async ({ person, browser, baseURL, db }) => {
  // Kills: `goal.months.at(-1)` → `goal.months[0]` (months-screen target of an ended goal).
  const { id, last } = await seedTerminada(db, person, 8, "Pintar corto");
  const { page, context } = await open(browser, baseURL, person.sessionFile, `/metas/${id}/meses`, 1280);
  try {
    const heading = page.locator("main h2").first();
    await expect(heading).toBeVisible();
    const text = (await heading.innerText()).toLowerCase();
    expect(text).toContain(monthName(last));
    expect(text).toContain(monthStartOf(last).slice(0, 4));
    expect(text, "not the first month").not.toContain(monthLabel(last - 7));
  } finally {
    await context.close();
  }
});

// ---- Paper ---------------------------------------------------------------------------------------------------------

for (const query of ["", "?todo=1"]) {
  test(`N1 on paper (/exportar${query}): PIANO · POR MES · 2 DE 120 MESES, two rows, the line, no «ver todo»`, async ({ person, browser, baseURL, db }) => {
    // Kills: `printSuffix` without the «de»; the paper changing with `?todo=1`.
    await seedPiano(db, person);
    const paper = await paperOf(browser, baseURL, person.sessionFile, `/exportar${query}`, "Piano");
    expect(paper).toContain("piano · por mes · 2 de 120 meses");
    expectInOrder(paper, [monthLabel(0), monthLabel(1), lineWords(118, 119)]);
    expect(paper).not.toContain("ver todo");
    expect(paper).not.toContain("ver menos");
  });
}

test("N3 on paper: LEER · POR MES · 14 DE 33 MESES, the label, December, the line", async ({ person, browser, baseURL, db }) => {
  // Kills: `printSuffix` without the «de»; the count of the printed rows in place of the goal's months.
  const id = await seedLeer(db, person, { endsIn: 9 });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain("leer · por mes · 14 de 33 meses");
  expectInOrder(paper, [monthLabel(-11), monthLabel(1), "estos meses con monto propio:", monthLabel(2), lineWords(7, 9)]);
});

test("N6 on paper: a goal of 10 months whose rows are all «sin monto» prints no «por mes» at all (RP-124)", async ({ person, browser, baseURL, db }) => {
  // Kills: the hide rule dropped, so the heading and a «5 meses» count print over rows that hold nothing.
  await seedLeer(db, person, { endsIn: 5, rhythm: null, opened: -4, name: "Inglés" });
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Inglés", false);
  expect(paper).toContain("inglés");
  expect(paper).not.toContain("inglés · por mes");
  expect(paper).not.toMatch(anyOfRe);
});

test("S16: a month set by hand and one month left out print «1 mes más, hasta el …» once", async ({ person, browser, baseURL, db }) => {
  // Kills: `{ownList.length === 0 ? closing : null}` → `{closing}` (survivor S16 of s6): the line twice.
  const id = await seedLeer(db, person, { endsIn: 3 });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper).toContain(lineWords(1, 3));
  expect(paper.split(lineWords(1, 3)).length - 1, "the line printed once").toBe(1);
});

test("S16: a month set by hand and seven left out print «7 meses más, hasta el …» once", async ({ person, browser, baseURL, db }) => {
  // Kills: the same, on the plural line.
  const id = await seedLeer(db, person, { endsIn: 9 });
  await budget(db, person, id, 2, 60);
  const paper = await paperOf(browser, baseURL, person.sessionFile, "/exportar", "Leer");
  expect(paper.split(lineWords(7, 9)).length - 1, "the line printed once").toBe(1);
});

// ---- 360 -----------------------------------------------------------------------------------------------------------

test("at 360 «Por mes» and the report of N1 and N3 fit with «de N», the label and «ver todo»", async ({ person, browser, baseURL, db }) => {
  // Kills: a caption or a label wider than the column (a class outside `components/ui`).
  const piano = await seedPiano(db, person);
  const leer = await seedLeer(db, person, { endsIn: 9, name: "Leer largo para medir el ancho del rótulo de la lista" });
  await budget(db, person, leer, 2, 60);
  for (const [path, caption] of [
    [`/metas/${piano}/meses`, ofRe(2, 120)],
    [`/metas/${leer}/meses`, ofRe(14, 33)],
    ["/exportar", ofRe(2, 120)],
  ] as const) {
    const { page, context } = await open(browser, baseURL, person.sessionFile, path, 360);
    try {
      await expect(page.locator("main").getByText(caption).first()).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, path).toBeLessThanOrEqual(0);
      const box = await page.locator("main").getByText(caption).first().boundingBox();
      expect(box!.x + box!.width, path).toBeLessThanOrEqual(360);
      expect((await yOf(seeAll(page.locator("main")))).top, path).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }
});
