import { test, expect } from "./fixtures";
import { printedPages, seedLeer33 } from "./papel-973-seed";
import { sectionOf } from "./mes-siguiente-seed";
import { seedPiano } from "./por-mes-de-n-seed";
import { monthLabel } from "./sin-final-seed";

// Module 973, RP-120, board MesesAnteriores face 3 (A4). On paper the line «12 meses anteriores» is text that opens nothing, stuck to the
// first row of the first table: after the «por mes» label, before the table's head, once, never at the foot of a sheet.
// Read from the plan's Done table; the PDF is the witness, never the markup.

const LABEL = "leer · por mes · 14 de 33 meses";
const LINE = "12 meses anteriores";

test("A2 on paper: «12 meses anteriores» sits once between the label and the first table's head, on the first row's sheet, within three lines of it", async ({
  person, browser, baseURL, db,
}) => {
  // Kills: not printing it; printing it in the `after` (below the table); printing it with the head that repeats on each sheet.
  await seedLeer33(db, person);
  const pages = await printedPages(browser, baseURL, person, "/exportar", "a2", ["Leer"]);
  const hits = pages.flatMap((lines, page) => lines.map((line, at) => ({ line, page, at }))).filter((entry) => entry.line === LINE);
  expect(hits, `«${LINE}» printed exactly once`).toHaveLength(1);
  const [hit] = hits;
  const label = pages[hit.page].indexOf(LABEL);
  expect(label, `«${LABEL}» on the line's sheet ${hit.page + 1}`).toBeGreaterThanOrEqual(0);
  expect(hit.at, "the line follows the label").toBeGreaterThan(label);
  const first = pages[hit.page].findIndex((line, at) => at > hit.at && line.startsWith(monthLabel(-11)));
  expect(first, `the first row «${monthLabel(-11)}» on the same sheet, below the line`).toBeGreaterThan(hit.at);
  expect(first - hit.at, "the line is stuck to the table: its head is the only thing between").toBeLessThanOrEqual(3);
  const head = pages[hit.page].findIndex((line, at) => at > hit.at && /^m ?e ?s .*h ?e ?c ?h ?o/.test(line));
  expect(head, "the line is above the head of the table").toBeGreaterThan(hit.at);
  expect(head).toBeLessThan(first);
  expect(hit.at, "the line never closes a sheet").toBeLessThan(pages[hit.page].length - 1);
});

test("A2 on paper: the line is plain text, not a link, and «ver todo» is not printed", async ({ person, browser, baseURL, db }) => {
  // Kills: leaving the `TextLink` on paper.
  await seedLeer33(db, person);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 794, height: 1123 } });
  try {
    const page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByRole("main").getByText("Leer", { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const shown = page.getByText(LINE, { exact: true }).locator("visible=true");
    await expect(shown, "one printed line").toHaveCount(1);
    expect(await shown.evaluate((node) => node.closest("a") !== null), "the printed line sits inside a link").toBe(false);
    await expect(page.getByRole("link", { name: LINE })).toHaveCount(0);
    await expect(sectionOf(page, "Leer").getByRole("link", { name: "ver todo", exact: true }).locator("visible=true")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("nothing hidden prints no such line (Piano, 2 de 120 meses)", async ({ person, browser, baseURL, db }) => {
  // Kills: printing the line with `hidden = 0`.
  await seedPiano(db, person);
  const pages = await printedPages(browser, baseURL, person, "/exportar", "piano", ["Piano"]);
  expect(pages.flat().filter((line) => /anteriores?$/.test(line))).toEqual([]);
});

test("`?todo=1` prints no such line", async ({ person, browser, baseURL, db }) => {
  // Kills: printing the line over the whole list.
  await seedLeer33(db, person);
  const pages = await printedPages(browser, baseURL, person, "/exportar?todo=1", "todo", ["Leer"]);
  expect(pages.flat().filter((line) => /meses anteriores$/.test(line))).toEqual([]);
  expect(pages.flat().some((line) => line.startsWith("leer · por mes")), "Leer's table is printed").toBe(true);
});
