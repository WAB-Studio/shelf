import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { test, expect, visit } from "./fixtures";
import { TODAY, drawn, monthLabel, monthStartOf, seedGoal, seedTap, shift } from "./sin-final-seed";

// `InformeSinFinal` (RP-99; decisions of 2026-10-13: «a goal with no end prints the same twelve months the screen shows»,
// the last 11 closed and the current one, RP-107): /exportar and its paper say nothing of an end for a goal that has none — no «hasta el …»,
// no «terminada el …» — and list its months up to the current one, never the ones ahead.
// Every month is an offset from the real current month, so the spec runs any day.

const A4 = { width: 794, height: 1123 };
const sectionOf = (page: Page, name: string) =>
  page.locator("section").filter({ has: page.getByText(`${name} · por mes`, { exact: true }) });
const rowOf = (section: Locator, offset: number) =>
  section.locator("li:visible, tbody tr:visible").filter({ hasText: new RegExp(monthLabel(offset), "i") });

// Opened 20 months ago: the closed months are the trap — «the same twelve months» are the last 11 closed and the current one (RP-107).
async function seedOpen(db: Parameters<typeof seedGoal>[0], personId: string, name: string, horizon: string | null) {
  const goalId = await seedGoal(db, personId, name, {
    horizon,
    unit: "páginas",
    budget: 34,
    created: new Date(Date.parse(`${monthStartOf(-20).slice(0, 8)}01T12:00:00Z`)),
  });
  await seedTap(db, personId, goalId, `Leer diez ${name}`);
  return goalId;
}

for (const width of [360, 1280]) {
  test(`at ${width} a goal with no end has no «hasta el» and lists its last 11 closed months and the current one, nothing ahead`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    // Kills: `dayBefore(goal.horizon)` unconditional (a «terminada el …» or «hasta el …» line), or a month list that
    // starts at the opening, or stops at a horizon that is not there.
    const name = `Leer ${Date.now()}`;
    const goalId = await seedOpen(db, person.id, name, null);
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 1000 },
    });
    try {
      const page = await context.newPage();
      await visit(page, "/exportar");
      await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
      const body = drawn(await page.locator("main").innerText());
      expect(body).toContain("mide en páginas");
      expect(body).not.toContain("hasta el");
      expect(body).not.toContain("terminada");
      expect(body).not.toContain("1969");
      expect(body).not.toContain("1970");

      const section = sectionOf(page, name);
      await expect(section.getByText("12 meses", { exact: true }).locator("visible=true")).toHaveCount(1);
      for (let offset = -11; offset <= 0; offset++) await expect(rowOf(section, offset), monthLabel(offset)).toHaveCount(1);
      await expect(rowOf(section, 1)).toHaveCount(0);
      await expect(rowOf(section, -12)).toHaveCount(0);
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
    }
  });
}

for (const query of ["", "?todo=1"]) {
test(`the paper of a goal with no end has no «hasta el» and prints the same twelve months, the last 11 closed and the current one (/exportar${query})`, async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills (also with `?todo=1`, RP-106: the closed months the screen opens leaking into the paper, or the «ver todo» link printed): the paper's own `dayBefore(goal.horizon)` or its month list running to a horizon (the screen is right, the PDF is not).
  const name = `Leer ${Date.now()}`;
  const goalId = await seedOpen(db, person.id, name, null);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: A4 });
  try {
    const page = await context.newPage();
    await visit(page, `/exportar${query}`);
    await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const dir = resolve(process.cwd(), "private/export-pdf");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `sin-final-${Date.now()}.pdf`);
    writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
    const paper = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).replace(/\s+/g, " ").toLowerCase();

    expect(paper).toContain(`${name} · por mes · 12 meses`.toLowerCase());
    expect(paper).not.toContain("hasta el");
    expect(paper).not.toContain("terminada");
    expect(paper).not.toContain("1969");
    expect(paper).not.toContain("1970");
    for (let offset = -11; offset <= 0; offset++) expect(paper, monthLabel(offset)).toContain(monthLabel(offset));
    expect(paper).not.toContain(monthLabel(1));
    expect(paper).not.toContain(monthLabel(-12));
    // RP-107: the paper always prints the same 12, whatever the screen shows (`?todo=1` included); and never the link.
    for (const offset of [-13, -20]) expect(paper, monthLabel(offset)).not.toContain(monthLabel(offset));
    expect(paper).not.toContain("ver todo");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
}

test("control: the same goal with an end says «hasta el» and ends its months at the horizon", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Not a kill: it holds the «hasta el» assertion above to a page that does say it.
  const name = `Leer ${Date.now()}`;
  const goalId = await seedOpen(db, person.id, name, shift(TODAY, 100));
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 1000 },
  });
  try {
    const page = await context.newPage();
    await visit(page, "/exportar");
    await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
    expect(drawn(await page.locator("main").innerText())).toContain("hasta el");
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goalId} and user_id = ${person.id}`;
  }
});
