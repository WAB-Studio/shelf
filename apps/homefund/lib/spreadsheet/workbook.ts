import "server-only";

import ExcelJS from "exceljs";

import type { ExportResult } from "@/db/queries/export";
import { BACKGROUND_SHEETS, READING_ORDER } from "@/lib/spreadsheet/sheet-layout";
import {
  SHEET_ENTITIES,
  sheetDescriptors,
  type RefEntity,
  type SheetEntity,
} from "@/lib/spreadsheet/schema";

// A parsed cell holds a resolved name, a scalar, integer cents or nothing — the
// shape `readExport` emits. The money boundary turns cents into a decimal COP
// number here and nowhere else.
type CellValue = string | number | boolean | null;

// One column seen through the shared contract: `satisfies` narrowed each literal,
// so only some carry `money` or `ref`; this view restores the optional markers for
// iteration without reaching back into a concrete descriptor's type.
type ColumnView = {
  readonly key: string;
  readonly field: string;
  readonly money?: { readonly toSheet: (cents: number) => number };
  readonly ref?: { readonly entity: RefEntity };
  readonly date?: true;
};

// The read side of the same column: the export writes a cell with `toSheet`, the
// import reads it back across `fromSheet`, so this view exposes the reverse boundary.
type ParseColumnView = {
  readonly key: string;
  readonly money?: { readonly fromSheet: (pesos: number) => number };
};

// The interface text a person reads on the sheet (RF-49): the localized tab name
// per entity and the localized header per descriptor column key. The route builds
// these from next-intl; this module stays free of the message catalogue.
export type SheetLabels = {
  readonly sheetName: (entity: SheetEntity) => string;
  readonly columnHeader: (key: string) => string;
};

// The hidden sheet the template's dropdowns read their options from. A fixed,
// space-free name so a cross-sheet list formula references it without quoting.
const OPTIONS_SHEET = "options";

// The template validates a generous span of rows so a person can paste many rows
// under each header and still get the dropdown. The options source stays exactly
// as long as its list, so the dropdown carries no trailing blank entries.
const TEMPLATE_DATA_ROWS = 500;

const DATE_FORMAT = "dd/mm/yyyy";
// Thousands separator, 2 decimals, a negative in red with its minus sign.
const MONEY_FORMAT = "#,##0.00;[Red]-#,##0.00";
const HEADER_FILL = "FFE8EEF4";
const MIN_WIDTH = 10;
const MAX_WIDTH = 50;

function orderedEntities(): SheetEntity[] {
  const rest = SHEET_ENTITIES.filter((entity) => !READING_ORDER.includes(entity));
  return [...READING_ORDER, ...rest];
}

// A civil day written as a date cell at UTC midnight, so no zone shifts the day on
// the way out; `readCell` reads it back through the same UTC day.
function civilDayCell(value: CellValue): CellValue | Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(`${value}T00:00:00Z`);
}

// The characters a cell shows: a money cell as its formatted text (separators,
// two decimals, the minus), a date cell as `dd/mm/yyyy`, anything else as itself.
function shownLength(value: CellValue | Date, column: ColumnView): number {
  if (value instanceof Date) return DATE_FORMAT.length;
  if (typeof value === "number" && column.money) {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).length;
  }
  return String(value ?? "").length;
}

// One sheet laid out: a bold light-filled header over the columns only, frozen, the
// date and money columns formatted as such, and widths fitted to the longest shown
// cell, measured as the rows go in. `filter` adds the header autofilter.
function fillSheet(
  sheet: ExcelJS.Worksheet,
  columns: readonly ColumnView[],
  headers: readonly string[],
  rows: readonly (CellValue | Date)[][],
  filter: boolean,
): void {
  const widths = headers.map((header) => header.length);
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(row);
    columns.forEach((column, index) => {
      widths[index] = Math.max(widths[index], shownLength(row[index], column));
    });
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  columns.forEach((column, index) => {
    const target = sheet.getColumn(index + 1);
    target.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, widths[index] + 2));
    if (column.date) target.numFmt = DATE_FORMAT;
    else if (column.money) target.numFmt = MONEY_FORMAT;
  });

  // Styled after the column formats, which reach the header cell too: it stays text.
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.numFmt = "General";
  });

  if (filter && columns.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
}

// Opens the workbook on its first visible sheet, so a hidden leading tab (the
// template's options) never becomes the active one.
function openOnFirstVisible(workbook: ExcelJS.Workbook): void {
  const first = workbook.worksheets.findIndex((sheet) => sheet.state === "visible");
  workbook.views = [
    { x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: Math.max(first, 0), visibility: "visible" },
  ];
}

// One cell's written value: a money column crosses the cents→pesos boundary right
// here (the only float in the pipeline), a null becomes an empty cell, the rest
// pass through as the resolved name or scalar `readExport` already produced.
function cellValue(column: ColumnView, value: CellValue): CellValue | Date {
  if (value == null) return null;
  if (column.money) return column.money.toSheet(value as number);
  if (column.date) return civilDayCell(value);
  return value;
}

// Spreadsheet column letter from a 1-based index (1→A, 27→AA), so a list formula
// can point at the right options column without hard-coding the letters.
function columnLetter(index: number): string {
  let remaining = index;
  let letter = "";
  while (remaining > 0) {
    const rem = (remaining - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letter;
}

// The absolute cross-sheet range a dropdown reads, or null when the list is empty
// — an empty range is not a valid list source, so that ref column keeps no rule.
function optionRange(columnIndex: number, count: number): string | null {
  if (count <= 0) return null;
  const letter = columnLetter(columnIndex);
  return `${OPTIONS_SHEET}!$${letter}$1:$${letter}$${count}`;
}

/**
 * The export workbook (RF-50): one worksheet per entity present in `data`, walked
 * in the fixed reading order (transactions first, the active tab) so every download
 * shares the same layout; the background sheets come last and hidden. A
 * header row from the descriptor's column order leads, the caller's rows follow,
 * each cell crossing the money boundary only where the descriptor marks it.
 */
export function buildWorkbook(input: {
  data: ExportResult;
  labels: SheetLabels;
  // Hide the background sheets. The full export does; a sheet the person picked
  // by name stays visible.
  hideBackground?: boolean;
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();

  const present = orderedEntities().filter((entity) => input.data[entity] !== undefined);
  // Hiding every sheet leaves nothing to open, so a selection of only background
  // sheets stays visible.
  const hideBackground =
    (input.hideBackground ?? true) && present.some((entity) => !BACKGROUND_SHEETS.has(entity));

  for (const entity of present) {
    const rows = input.data[entity] ?? [];
    const columns = sheetDescriptors[entity].columns as readonly ColumnView[];
    const hidden = hideBackground && BACKGROUND_SHEETS.has(entity);
    const sheet = workbook.addWorksheet(input.labels.sheetName(entity), {
      state: hidden ? "hidden" : "visible",
    });

    fillSheet(
      sheet,
      columns,
      columns.map((column) => input.labels.columnHeader(column.key)),
      rows.map((row) => {
        const record = row as Record<string, CellValue>;
        return columns.map((column) => cellValue(column, record[column.key]));
      }),
      entity === "transactions",
    );
  }

  openOnFirstVisible(workbook);
  return workbook;
}

/**
 * The fill-in template (RF-49): every sheet, header row only, plus a hidden
 * options sheet holding the caller's existing account and category names. Every
 * account-referencing column (transactions/recurring `fromAccount`/`toAccount`)
 * gets a dropdown against the account list; every category-referencing column
 * (recurring `category`, categories `parent`) against the category list — the
 * reason a workbook, not a CSV, ships here.
 */
export function buildTemplate(input: {
  labels: SheetLabels;
  accountNames: string[];
  categoryNames: string[];
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();

  const options = workbook.addWorksheet(OPTIONS_SHEET, { state: "hidden" });
  input.accountNames.forEach((name, index) => {
    options.getCell(index + 1, 1).value = name;
  });
  input.categoryNames.forEach((name, index) => {
    options.getCell(index + 1, 2).value = name;
  });

  // A labels cell holds several names, so no single-pick list can offer them.
  const rangeByRef: Partial<Record<RefEntity, string | null>> = {
    accounts: optionRange(1, input.accountNames.length),
    categories: optionRange(2, input.categoryNames.length),
  };

  for (const entity of orderedEntities()) {
    const sheet = workbook.addWorksheet(input.labels.sheetName(entity));
    const columns = sheetDescriptors[entity].columns as readonly ColumnView[];

    fillSheet(
      sheet,
      columns,
      columns.map((column) => input.labels.columnHeader(column.key)),
      [],
      entity === "transactions",
    );

    columns.forEach((column, index) => {
      if (!column.ref) return;
      const range = rangeByRef[column.ref.entity];
      if (range == null) return;

      const columnIndex = index + 1;
      for (let row = 2; row <= TEMPLATE_DATA_ROWS; row += 1) {
        sheet.getCell(row, columnIndex).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [range],
        };
      }
    });
  }

  openOnFirstVisible(workbook);
  return workbook;
}

// The reverse of `SheetLabels`: the writer turned an entity into a tab name and a
// column key into a header, so the reader turns a tab name back into its entity and
// a header back into its column key. Built by the action from the SAME next-intl
// namespaces the writer used, for the request locale, so a localized file round-trips.
// This module stays free of the message catalogue; the maps arrive resolved.
export type ReverseSheetLabels = {
  readonly entityBySheetName: ReadonlyMap<string, SheetEntity>;
  readonly columnKeyByHeader: ReadonlyMap<SheetEntity, ReadonlyMap<string, string>>;
};

// One parsed data row: the cells keyed by the descriptor's column `key`, and the
// sheet's own row number — the one a person sees opening the file in Excel, header
// counted, a skipped blank row included. Never the array position: a blank line in
// the middle of the file pulls the two apart (RF-51).
export type ParsedRow = { record: Record<string, CellValue>; sheetRow: number };

// Every entity's raw rows. An entity whose sheet is absent (or holds no data rows)
// has no key here.
export type ParsedWorkbook = Partial<Record<SheetEntity, ParsedRow[]>>;

// One cell reduced to a plain scalar: a formula yields its cached result, a
// hyperlink or rich-text run its text, a date its civil day, an error nothing. A
// blank or whitespace-only string reads as null, so an untouched cell counts as
// empty rather than a value.
function readCell(value: ExcelJS.CellValue): CellValue {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return value.result == null ? null : readCell(value.result);
    if ("richText" in value) return readCell(value.richText.map((run) => run.text).join(""));
    if ("text" in value) return readCell(value.text);
  }
  return null;
}

// The header text of a cell, untrimmed-to-null unlike a data cell: an empty header
// names no column, so it maps to nothing.
function headerText(value: ExcelJS.CellValue): string | null {
  const text = readCell(value);
  return typeof text === "string" ? text : null;
}

/**
 * The inverse of `buildWorkbook` (RF-51): reads an uploaded `.xlsx` back into raw
 * per-entity records. Sheets match by tab name and columns by header text, never by
 * position — a person may reorder or drop columns and the file still parses; an
 * unknown sheet or header is ignored. A money column crosses `fromSheet` here, the
 * one float in the pipeline, at this boundary. No database access and no catalogue:
 * the caller supplies the reverse label maps and later resolves names to ids.
 */
export async function parseWorkbook(input: {
  buffer: ArrayBuffer;
  labels: ReverseSheetLabels;
}): Promise<ParsedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS's `Buffer` is an empty extension of `ArrayBuffer`, so the file bytes go
  // straight in; JSZip reads an `ArrayBuffer` at runtime.
  await workbook.xlsx.load(input.buffer);

  const result: ParsedWorkbook = {};

  workbook.eachSheet((sheet) => {
    const entity = input.labels.entityBySheetName.get(sheet.name);
    if (entity === undefined) return;

    const headerToKey = input.labels.columnKeyByHeader.get(entity);
    if (headerToKey === undefined) return;

    const columns = sheetDescriptors[entity].columns as readonly ParseColumnView[];
    const moneyByKey = new Map(columns.map((column) => [column.key, column.money] as const));

    // A header row maps a physical column index to its descriptor key; a header the
    // reverse map does not know stays unmapped, so its column drops out.
    const keyByColumn = new Map<number, string>();
    sheet.getRow(1).eachCell((cell, columnNumber) => {
      const header = headerText(cell.value);
      if (header === null) return;
      const key = headerToKey.get(header);
      if (key !== undefined) keyByColumn.set(columnNumber, key);
    });

    const rows: ParsedRow[] = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const record: Record<string, CellValue> = {};
      let hasValue = false;

      keyByColumn.forEach((key, columnNumber) => {
        const cell = readCell(row.getCell(columnNumber).value);
        const money = moneyByKey.get(key);
        const value =
          money !== undefined && typeof cell === "number" ? money.fromSheet(cell) : cell;
        record[key] = value;
        if (value !== null) hasValue = true;
      });

      // A row with no value under any known column is a blank template line, not an
      // import: it counts toward neither the row cap nor per-row validation. Its
      // number is skipped along with it, so the next real row keeps its own.
      if (hasValue) rows.push({ record, sheetRow: rowNumber });
    }

    result[entity] = rows;
  });

  return result;
}
