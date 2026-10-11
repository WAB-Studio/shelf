import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

// RP-71, RP-32 (module 805, `ReporteImpresoTablaLarga.dc.html` and docs/pulsar/DESIGN.md): on the wide face of
// `Table`, every figure of a row sits on the label's FIRST line. A row's `detail` («en curso», «cerrado · N % pasó a …»,
// a week's dates) sits under the label alone. Rows without a detail keep the height they had.
//
// Baselines are read from the rendered page: a zero-size inline-block dropped in front of a cell's first text sits on
// that line's baseline, so the figure's size and its line-height cannot hide a row that is one line off.
const NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const labelOf = (offset: number) => `${NAMES[Number(startOf(offset).slice(5, 7)) - 1]} ${startOf(offset).slice(0, 4)}`;

const A4 = { width: 794, height: 1123 };
const DESKTOP = { width: 1440, height: 900 };
const TOLERANCE = 2;
// Row heights of a month without a detail, measured on the build before the fix.
const PAPER_ROW = 32.25;
const SCREEN_ROW = 66.5;

type Measured = {
  label: string;
  baseLabel: number;
  baseFigure: number;
  basePlanned: number | null;
  figureText: string;
  plannedText: string | null;
  figureBottom: number;
  detailText: string | null;
  detailTop: number | null;
  rowHeight: number;
};

// `table`: the text of the label the table comes after («<goal> · por mes»), or null for the page's one table.
async function measure(page: Page, table: string | null, label: string): Promise<Measured> {
  const found = await page.evaluate(
    ({ table, label }) => {
      const textNodes = (root: Node): Text[] => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const out: Text[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? "").trim()) out.push(n as Text);
        return out;
      };
      const all = [...document.querySelectorAll("table")].filter((t) => getComputedStyle(t).display !== "none");
      let wide: HTMLTableElement | undefined;
      if (table === null) wide = all[0];
      else {
        const anchor = textNodes(document.body).find((n) => (n.textContent ?? "").includes(table));
        wide = all.find((t) => anchor && anchor.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      }
      if (!wide) return { error: `no visible table after «${table}»` };
      const row = [...wide.querySelectorAll("tbody tr")].find((tr) =>
        (tr.querySelector("td")?.textContent ?? "").trim().startsWith(label),
      ) as HTMLTableRowElement | undefined;
      if (!row) return { error: `no row «${label}»` };
      const cells = [...row.querySelectorAll("td")];
      const baseline = (node: Text): number => {
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0";
        node.parentNode!.insertBefore(probe, node);
        const bottom = probe.getBoundingClientRect().bottom;
        probe.remove();
        return bottom;
      };
      const rect = (node: Node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      };
      const labelNodes = textNodes(cells[0]);
      const figureNodes = textNodes(cells[1]);
      const plannedNodes = cells[2] ? textNodes(cells[2]) : [];
      const detail = labelNodes[1];
      return {
        label: (labelNodes[0].textContent ?? "").trim(),
        baseLabel: baseline(labelNodes[0]),
        baseFigure: baseline(figureNodes[0]),
        basePlanned: plannedNodes[0] ? baseline(plannedNodes[0]) : null,
        figureText: (figureNodes[0].textContent ?? "").trim(),
        plannedText: plannedNodes[0] ? (plannedNodes[0].textContent ?? "").trim() : null,
        figureBottom: Math.max(...figureNodes.map((n) => rect(n).bottom)),
        detailText: detail ? (detail.textContent ?? "").trim() : null,
        detailTop: detail ? rect(detail).top : null,
        rowHeight: row.getBoundingClientRect().height,
      };
    },
    { table, label },
  );
  if ("error" in found) throw new Error(found.error);
  return found as Measured;
}

// A goal measured in minutes, opened last month: last month closed with a task left over, this month in course,
// next month planned. Every month is an offset from the real current month.
async function seed(db: postgres.Sql, person: Person, name: string): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${startOf(4)}::date, 'Práctica', 'minutos',
            (${startOf(-1)}::date + interval '14 days' + interval '12 hours')::timestamptz)
    returning id
  `;
  for (const offset of [-1, 0, 1, 2]) {
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${goal.id}, ${startOf(offset)}::date, 600)
    `;
  }
  await db`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month)
    values (${person.id}, ${goal.id}, ${`Pendiente ${Date.now()}`}, 110, ${startOf(-1)}::date)
  `;
  const [finished] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, estimate, planned_month)
    values (${person.id}, ${goal.id}, ${`Hecha ${Date.now()}`}, 200, ${startOf(-1)}::date)
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${finished.id}, ${`${startOf(-1).slice(0, 8)}18`}::date)
  `;
  return goal.id;
}

async function openReport(
  browser: Browser, baseURL: string, person: Person, name: string, viewport: { width: number; height: number }, print: boolean,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL, viewport });
  const page = await context.newPage();
  await page.goto("/exportar");
  await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  if (print) await page.emulateMedia({ media: "print" });
  return { context, page };
}

const remove = (db: postgres.Sql, person: Person, id: string) =>
  db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;

type Ctx = { person: Person; browser: Browser; baseURL: string; db: postgres.Sql };
async function withReport(
  ctx: Ctx, tag: string, viewport: { width: number; height: number }, print: boolean,
  check: (page: Page, table: string) => Promise<void>,
) {
  const name = `Inglés ${tag} ${Date.now()}`;
  const id = await seed(ctx.db, ctx.person, name);
  const { context, page } = await openReport(ctx.browser, ctx.baseURL, ctx.person, name, viewport, print);
  try {
    await check(page, `${name} · por mes`);
  } finally {
    await context.close();
    await remove(ctx.db, ctx.person, id);
  }
}

const current = labelOf(0);
const closed = labelOf(-1);
const ahead = labelOf(1);
const after = labelOf(2);

function figuresOnFirstLine(m: Measured, what: string) {
  expect(m.baseFigure, `${what}: HECHO «${m.figureText}» baseline ${m.baseFigure} against the label «${m.label}» ${m.baseLabel}`)
    .toBeGreaterThan(m.baseLabel - TOLERANCE);
  expect(Math.abs(m.baseFigure - m.baseLabel), `${what}: HECHO «${m.figureText}» vs label «${m.label}»`).toBeLessThanOrEqual(TOLERANCE);
}

// The printed page is read from the PDF itself (`page.pdf`, `pdftotext -bbox`): print media on the screen does not
// fragment rows (`break-inside: avoid`), and the defect lives in the fragmented layout. Boxes are in points (1 px = 0.75 pt).
const PT_TOLERANCE = 2 * 0.75;

type PdfRow = {
  label: Word;
  figure: Word;
  planned: Word;
  detail: Word | null;
  pitch: number;
};

function pdfRow(file: string, stamp: string, label: string, next: string): PdfRow {
  const words = pdfWords(file);
  const last = words.map((w) => w.text).lastIndexOf(stamp);
  expect(last, `goal stamp «${stamp}» in the PDF (${file})`).toBeGreaterThanOrEqual(0);
  const find = (text: string, from: number, below?: Word) => {
    const [month, year] = text.split(" ");
    return words.findIndex(
      (w, i) =>
        i > from && w.text === month && w.x0 < 60 &&
        (!below || w.page > below.page || (w.page === below.page && w.y0 > below.y0)) &&
        words.some((y) => y.page === w.page && y.text === year && Math.abs(y.y0 - w.y0) < 1 && y.x0 > w.x1 && y.x0 < w.x1 + 12),
    );
  };
  const at = find(label, last);
  expect(at, `row «${label}» in the PDF (${file})`).toBeGreaterThanOrEqual(0);
  const to = find(next, last, words[at]);
  expect(to, `row «${next}» in the PDF (${file})`).toBeGreaterThanOrEqual(0);
  const row = words[at];
  const header = (text: string) => {
    const hit = words.find((w, i) => i > last && w.text === text);
    expect(hit, `column head «${text}» (${file})`).toBeDefined();
    return hit!.x0;
  };
  const hechoX = header("HECHO");
  const plannedX = header("PLANEADO");
  const top = row.y0 - 6;
  const bottom = words[to].y0 - 6;
  const band = words.filter((w) => w.page === row.page && w.y0 >= top && w.y0 < bottom);
  const inColumn = (x: number) =>
    band.filter((w) => Math.abs(w.x0 - x) < 2).sort((a, b) => a.y0 - b.y0)[0];
  const figure = inColumn(hechoX);
  const planned = inColumn(plannedX);
  expect(figure, `HECHO of «${label}» (${file})`).toBeDefined();
  expect(planned, `PLANEADO of «${label}» (${file})`).toBeDefined();
  const under = band
    .filter((w) => Math.abs(w.x0 - row.x0) < 2 && w.y0 > row.y0 + 3)
    .sort((a, b) => a.y0 - b.y0)[0];
  return { label: row, figure, planned, detail: under ?? null, pitch: words[to].y0 - row.y0 };
}

// PLANEADO is set in the sans face, its glyph box a little lower than the mono label's even on a row with no state:
// a row's PLANEADO is judged against that undisturbed row of the same page, never against the label alone.
const offsetOf = (row: PdfRow) => row.planned.y0 - row.label.y0;
const reference = (file: string, stamp: string) => pdfRow(file, stamp, ahead, after);

async function withPdf(
  ctx: Ctx, tag: string, check: (file: string, stamp: string) => void,
) {
  const stamp = String(Date.now());
  const name = `Inglés ${tag} ${stamp}`;
  const id = await seed(ctx.db, ctx.person, name);
  const { context, page } = await openReport(ctx.browser, ctx.baseURL, ctx.person, name, A4, true);
  try {
    check(await printToPdf(page, tag), stamp);
  } finally {
    await context.close();
    await remove(ctx.db, ctx.person, id);
  }
}

test.describe("paper (PDF): a «por mes» row with a detail keeps its figures on the label's first line (RP-71)", () => {
  test("the current month's HECHO «0 min» sits on the label's baseline, not on «en curso»", async ({ person, browser, baseURL, db }) => {
    await withPdf({ person, browser, baseURL: baseURL!, db }, "pc", (file, stamp) => {
      const row = pdfRow(file, stamp, current, ahead);
      expect(row.detail?.text, "the state under the label").toBe("en");
      expect(row.figure.text).toBe("0");
      expect(
        Math.abs(row.figure.y0 - row.label.y0),
        `HECHO «${row.figure.text}» at ${row.figure.y0}pt, label «${row.label.text}» at ${row.label.y0}pt (${file})`,
      ).toBeLessThanOrEqual(PT_TOLERANCE);
    });
  });

  test("the current month's PLANEADO «10 h» sits on the label's baseline", async ({ person, browser, baseURL, db }) => {
    await withPdf({ person, browser, baseURL: baseURL!, db }, "pp", (file, stamp) => {
      const row = pdfRow(file, stamp, current, ahead);
      expect(row.planned.text).toBe("10");
      expect(
        Math.abs(offsetOf(row) - offsetOf(reference(file, stamp))),
        `PLANEADO «${row.planned.text}» sits ${offsetOf(row)}pt from its label, a row with no state ${offsetOf(reference(file, stamp))}pt (${file})`,
      ).toBeLessThanOrEqual(PT_TOLERANCE);
    });
  });

  test("«en curso» sits under the figure, never beside it", async ({ person, browser, baseURL, db }) => {
    await withPdf({ person, browser, baseURL: baseURL!, db }, "pd", (file, stamp) => {
      const row = pdfRow(file, stamp, current, ahead);
      expect(row.detail?.text).toBe("en");
      expect(
        row.detail!.y0,
        `«en curso» top ${row.detail!.y0}pt against the figure's bottom ${row.figure.y1}pt (${file})`,
      ).toBeGreaterThan(row.figure.y1 - PT_TOLERANCE);
    });
  });

  test("a closed month with «cerrado · N % pasó a …» has HECHO and PLANEADO on the first line, the state under the label", async ({
    person, browser, baseURL, db,
  }) => {
    await withPdf({ person, browser, baseURL: baseURL!, db }, "pk", (file, stamp) => {
      const row = pdfRow(file, stamp, closed, current);
      expect(row.detail?.text, "the state under the label").toBe("cerrado");
      expect(
        Math.abs(row.figure.y0 - row.label.y0),
        `closed HECHO «${row.figure.text}» at ${row.figure.y0}pt, label at ${row.label.y0}pt (${file})`,
      ).toBeLessThanOrEqual(PT_TOLERANCE);
      expect(
        Math.abs(offsetOf(row) - offsetOf(reference(file, stamp))),
        `closed PLANEADO «${row.planned.text}» sits ${offsetOf(row)}pt from its label, a row with no state ${offsetOf(reference(file, stamp))}pt (${file})`,
      ).toBeLessThanOrEqual(PT_TOLERANCE);
      expect(row.detail!.y0, "state under the figure").toBeGreaterThan(row.figure.y1 - PT_TOLERANCE);
    });
  });

  test("a month with no detail keeps its row height on paper", async ({ person, browser, baseURL, db }) => {
    await withPdf({ person, browser, baseURL: baseURL!, db }, "ph", (file, stamp) => {
      const row = pdfRow(file, stamp, ahead, after);
      expect(row.detail).toBeNull();
      expect(row.pitch, `row «${ahead}» to «${after}» pitch (${file})`).toBeGreaterThanOrEqual(PAPER_ROW - 0.8);
      expect(row.pitch, `row «${ahead}» to «${after}» pitch (${file})`).toBeLessThanOrEqual(PAPER_ROW + 0.8);
    });
  });
});

test.describe("screen at 1440: the same on the wide face (RP-71)", () => {
  test("/exportar: current and closed months have HECHO and PLANEADO on the label's first line, detail under", async ({
    person, browser, baseURL, db,
  }) => {
    await withReport({ person, browser, baseURL: baseURL!, db }, "sc", DESKTOP, false, async (page, table) => {
      for (const label of [current, closed]) {
        const m = await measure(page, table, label);
        expect(m.detailText, `${label} has a detail`).not.toBeNull();
        figuresOnFirstLine(m, `screen ${label}`);
        expect(Math.abs(m.basePlanned! - m.baseLabel), `screen ${label} PLANEADO vs label`).toBeLessThanOrEqual(TOLERANCE);
        expect(m.detailTop!, `screen ${label}: detail under the figure`).toBeGreaterThan(m.figureBottom - TOLERANCE);
      }
    });
  });

  test("/exportar: a month with no detail keeps its row height on screen", async ({ person, browser, baseURL, db }) => {
    await withReport({ person, browser, baseURL: baseURL!, db }, "sh", DESKTOP, false, async (page, table) => {
      const m = await measure(page, table, ahead);
      expect(m.detailText).toBeNull();
      expect(m.rowHeight, `screen row «${ahead}» height`).toBeGreaterThanOrEqual(SCREEN_ROW - 1);
      expect(m.rowHeight, `screen row «${ahead}» height`).toBeLessThanOrEqual(SCREEN_ROW + 1);
    });
  });

  test("goal review: «semana 1» and its figure share a line, the week's dates under the label", async ({
    person, browser, baseURL, db,
  }) => {
    const name = `Revisión fila ${Date.now()}`;
    const id = await seed(db, person, name);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: DESKTOP });
    try {
      const page = await context.newPage();
      await page.goto(`/metas/${id}/revision`);
      await expect(page.getByRole("table")).toBeVisible();
      const m = await measure(page, null, "semana 1");
      expect(m.detailText, "the week's dates").toMatch(/\d/);
      figuresOnFirstLine(m, "goal review week 1");
      expect(m.detailTop!, "dates under the figure").toBeGreaterThan(m.figureBottom - TOLERANCE);
    } finally {
      await context.close();
      await remove(db, person, id);
    }
  });
});

type Word = { text: string; page: number; x0: number; y0: number; x1: number; y1: number };

// Every word of the printed PDF with its box, in points.
function pdfWords(file: string): Word[] {
  const xml = execFileSync("pdftotext", ["-bbox", file, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const words: Word[] = [];
  let page = -1;
  for (const line of xml.split("\n")) {
    if (line.includes("<page ")) page += 1;
    const m = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*)<\/word>/.exec(line);
    if (m) words.push({ text: m[5], page, x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] });
  }
  return words;
}

async function printToPdf(page: Page, tag: string): Promise<string> {
  const dir = resolve(process.cwd(), "private/export-pdf");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `fila-detalle-${tag}-${Date.now()}.pdf`);
  writeFileSync(file, await page.pdf({ preferCSSPageSize: true }));
  return file;
}

