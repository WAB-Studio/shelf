import "server-only";

import ExcelJS from "exceljs";

import type { ExportResult } from "@/db/queries/export";
import {
  SHEET_ENTITIES,
  sheetDescriptors,
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
  readonly ref?: { readonly entity: "accounts" | "categories" };
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

// One cell's written value: a money column crosses the cents→pesos boundary right
// here (the only float in the pipeline), a null becomes an empty cell, the rest
// pass through as the resolved name or scalar `readExport` already produced.
function cellValue(column: ColumnView, value: CellValue): CellValue {
  if (value == null) return null;
  if (column.money) return column.money.toSheet(value as number);
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
 * in the fixed `SHEET_ENTITIES` order so every download shares the same layout. A
 * header row from the descriptor's column order leads, the caller's rows follow,
 * each cell crossing the money boundary only where the descriptor marks it.
 */
export function buildWorkbook(input: {
  data: ExportResult;
  labels: SheetLabels;
}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();

  for (const entity of SHEET_ENTITIES) {
    const rows = input.data[entity];
    if (rows === undefined) continue;

    const sheet = workbook.addWorksheet(input.labels.sheetName(entity));
    const columns = sheetDescriptors[entity].columns as readonly ColumnView[];

    sheet.addRow(columns.map((column) => input.labels.columnHeader(column.key)));

    for (const row of rows) {
      const record = row as Record<string, CellValue>;
      sheet.addRow(columns.map((column) => cellValue(column, record[column.key])));
    }
  }

  return workbook;
}

/**
 * The fill-in template (RF-49): all five sheets, header row only, plus a hidden
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

  const rangeByRef: Record<"accounts" | "categories", string | null> = {
    accounts: optionRange(1, input.accountNames.length),
    categories: optionRange(2, input.categoryNames.length),
  };

  for (const entity of SHEET_ENTITIES) {
    const sheet = workbook.addWorksheet(input.labels.sheetName(entity));
    const columns = sheetDescriptors[entity].columns as readonly ColumnView[];

    sheet.addRow(columns.map((column) => input.labels.columnHeader(column.key)));

    columns.forEach((column, index) => {
      if (!column.ref) return;
      const range = rangeByRef[column.ref.entity];
      if (range === null) return;

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
