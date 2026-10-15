import ExcelJS from "exceljs";

import { isHourUnit, isTimeUnit } from "@/lib/units/time";

import type { ImportDraft, Source, Src } from "./draft";
import { parseTemplate, TEMPLATE_HEADER, type FormCode } from "./template";

export const WORKBOOK_NAME = "plantilla-pulsar.xlsx";

// A broken row, named by its sheet and the row number Excel shows.
export type WorkbookError = { sheet: string; row: number; expected: FormCode };

const HEADERS = {
  Metas: ["nombre", "dentro de", "horizonte", "medida", "unidad", "ritmo", "nota"],
  Fases: ["meta", "desde", "hasta", "objetivo"],
  Meses: ["meta", "mes", "monto"],
  Compromisos: ["meta", "nombre", "cadencia", "toque o monto"],
  Tareas: ["meta", "mes", "tarea", "sub-tarea", "monto", "nota"],
} as const;
type SheetName = keyof typeof HEADERS;
const SHEETS = Object.keys(HEADERS) as SheetName[];

// The row of a sheet's headers: `Metas` carries the mark above them.
const headerRow = (sheet: SheetName) => (sheet === "Metas" ? 2 : 1);

// The form a sheet's broken row should have taken.
const FORM_OF: Record<SheetName, FormCode> = {
  Metas: "import.errors.form.goal",
  Fases: "import.errors.form.phase",
  Meses: "import.errors.form.month",
  Compromisos: "import.errors.form.commitment",
  Tareas: "import.errors.form.task",
};
const CHILD_FORM: FormCode = "import.errors.form.child";

type Kind = "text" | "month" | "date" | "amount";

const pad = (n: number) => String(n).padStart(2, "0");

// The calendar day Excel stored: exceljs hands a date cell back as UTC midnight of that day.
function civil(date: Date, kind: Kind): string {
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
  return kind === "month" ? day : `${day}-${pad(date.getUTCDate())}`;
}

function plainText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return civil(value, "date");
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("result" in value) return plainText(value.result as ExcelJS.CellValue);
    if ("text" in value) return plainText(value.text as ExcelJS.CellValue);
    return "";
  }
  return String(value);
}

function cellValue(value: ExcelJS.CellValue, kind: Kind): string {
  if (value instanceof Date) return civil(value, kind === "month" ? "month" : "date");
  if (typeof value === "object" && value !== null && "result" in value && value.result instanceof Date) {
    return civil(value.result, kind === "month" ? "month" : "date");
  }
  return plainText(value).replace(/\r\n?/g, "\n").trim();
}

// A bare number in the amount of a goal in hours is hours, in minutes is minutes.
function amountOf(text: string, unit: string): string {
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return text;
  if (isHourUnit(unit)) return `${text.replace(".", ",")} h`;
  if (isTimeUnit(unit)) return `${text} min`;
  return text;
}

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

type Row = { sheet: SheetName; row: number; id: number; cells: string[] };
type Entry = { sheet: SheetName; row: number; id: number | null };

// Whether the sheet, and its headers on their row, are the template's.
function headersMatch(sheet: ExcelJS.Worksheet, name: SheetName): boolean {
  const row = sheet.getRow(headerRow(name));
  return HEADERS[name].every((header, i) => plainText(row.getCell(i + 1).value).trim().toLowerCase() === header);
}

function readRows(sheet: ExcelJS.Worksheet, name: SheetName, firstId: number): Row[] {
  const rows: Row[] = [];
  let id = firstId;
  const width = HEADERS[name].length;
  for (let r = headerRow(name) + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells = Array.from({ length: width }, (_, i) => {
      const kind: Kind =
        name === "Metas" ? (i === 2 ? "date" : i === 5 ? "amount" : "text")
        : name === "Fases" ? (i === 1 || i === 2 ? "date" : "text")
        : name === "Meses" ? (i === 1 ? "month" : i === 2 ? "amount" : "text")
        : name === "Compromisos" ? (i === 3 ? "amount" : "text")
        : i === 1 ? "month" : i === 4 ? "amount" : "text";
      return cellValue(row.getCell(i + 1).value, kind);
    });
    if (cells.every((cell) => cell === "")) continue;
    rows.push({ sheet: name, row: r, id: id++, cells });
  }
  return rows;
}

// The ranges of rows a list of row numbers makes.
function toRanges(ids: number[]): Src[] {
  const out: Src[] = [];
  for (const n of [...new Set(ids)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.to === n - 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

export async function readWorkbook(
  bytes: Uint8Array,
): Promise<{ matched: false } | { matched: true; draft: ImportDraft; source: Source } | { matched: true; errors: WorkbookError[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as never);
  } catch {
    return { matched: false };
  }
  const metas = wb.getWorksheet("Metas");
  if (!metas || plainText(metas.getCell("A1").value).trim() !== TEMPLATE_HEADER) return { matched: false };

  // A broken header or a missing sheet cuts the read: nothing below it is judged.
  for (const name of SHEETS) {
    const sheet = wb.getWorksheet(name);
    if (!sheet || !headersMatch(sheet, name)) {
      return { matched: true, errors: [{ sheet: name, row: headerRow(name), expected: FORM_OF[name] }] };
    }
  }

  const rows = new Map<SheetName, Row[]>();
  let next = 1;
  for (const name of SHEETS) {
    const read = readRows(wb.getWorksheet(name)!, name, next);
    next += read.length;
    rows.set(name, read);
  }

  const lines: { text: string; entry: Entry | null }[] = [{ text: TEMPLATE_HEADER, entry: null }];
  const early: WorkbookError[] = [];
  const push = (text: string, row: Row) => lines.push({ text, entry: { sheet: row.sheet, row: row.row, id: row.id } });
  const notes = (prefix: string, note: string, row: Row) => {
    if (note !== "") for (const line of note.split("\n")) push(line.trim() === "" ? `${prefix}nota:` : `${prefix}nota: ${line.trim()}`, row);
  };

  const goals = rows.get("Metas")!;
  const unitOf = new Map<string, string>();
  for (const goal of goals) if (!unitOf.has(goal.cells[0])) unitOf.set(goal.cells[0], goal.cells[4]);
  const forGoal = (name: SheetName, goalName: string) => rows.get(name)!.filter((row) => row.cells[0] === goalName);

  const named = new Set(goals.map((goal) => goal.cells[0]).filter((name) => name !== ""));
  for (const sheet of SHEETS.slice(1)) {
    for (const row of rows.get(sheet)!) if (!named.has(row.cells[0])) early.push({ sheet, row: row.row, expected: FORM_OF[sheet] });
  }

  for (const goal of goals) {
    const [name, inside, horizon, measure, unit, rhythm, note] = goal.cells;
    if (name === "") {
      early.push({ sheet: "Metas", row: goal.row, expected: FORM_OF.Metas });
      continue;
    }
    push(`# ${oneLine(name)}`, goal);
    if (horizon !== "") push(`horizonte: ${oneLine(horizon)}`, goal);
    if (inside !== "") push(`dentro de: ${oneLine(inside)}`, goal);
    if (measure !== "" || unit !== "") push(`medida: ${oneLine(measure)} · ${oneLine(unit)}`, goal);
    if (rhythm !== "") push(`ritmo: ${oneLine(amountOf(rhythm, unit))}`, goal);
    notes("", note, goal);

    const section = (title: string, sheet: SheetName, line: (row: Row, unit: string) => string) => {
      const own = forGoal(sheet, name);
      if (own.length === 0) return;
      lines.push({ text: title, entry: { sheet: "Metas", row: goal.row, id: goal.id } });
      for (const row of own) push(line(row, unit), row);
    };
    section("## Fases", "Fases", (r) => `- ${oneLine(r.cells[1])} a ${oneLine(r.cells[2])} · ${oneLine(r.cells[3])}`);
    section("## Meses", "Meses", (r, u) => `- ${oneLine(r.cells[1])} · ${oneLine(amountOf(r.cells[2], u))}`);
    section("## Compromisos", "Compromisos", (r, u) => `- ${oneLine(r.cells[1])} · ${oneLine(r.cells[2])} · ${oneLine(amountOf(r.cells[3], u))}`);

    const tasks = forGoal("Tareas", name);
    if (tasks.length > 0) {
      lines.push({ text: "## Tareas", entry: { sheet: "Metas", row: goal.row, id: goal.id } });
      // A sub-task goes under the last task of its month that has no sub-task cell.
      const parents: { row: Row; children: Row[] }[] = [];
      for (const row of tasks) {
        if (row.cells[3] === "") parents.push({ row, children: [] });
        else {
          const parent = [...parents].reverse().find((p) => p.row.cells[1] === row.cells[1]);
          if (parent) parent.children.push(row);
          else early.push({ sheet: "Tareas", row: row.row, expected: CHILD_FORM });
        }
      }
      for (const { row, children } of parents) {
        const [, month, task, , amount, taskNote] = row.cells;
        const figure = amountOf(amount, unit);
        push(figure === "" ? `- ${oneLine(month)} · ${oneLine(task)}` : `- ${oneLine(month)} · ${oneLine(figure)} · ${oneLine(task)}`, row);
        notes("  ", taskNote, row);
        for (const child of children) {
          const childFigure = amountOf(child.cells[4], unit);
          push(childFigure === "" ? `  - ${oneLine(child.cells[3])}` : `  - ${oneLine(childFigure)} · ${oneLine(child.cells[3])}`, child);
          notes("    ", child.cells[5], child);
        }
      }
    }
  }

  const result = parseTemplate(lines.map((l) => l.text).join("\n"));
  if (!("draft" in result) && !("errors" in result)) return { matched: false };

  const found: WorkbookError[] = [...early];
  if ("errors" in result) {
    for (const error of result.errors) {
      // A line outside every row (an empty file) is the first row of Metas.
      const entry = lines[error.line - 1]?.entry ?? { sheet: "Metas" as const, row: 3 };
      found.push({ sheet: entry.sheet, row: entry.row, expected: error.expected });
    }
  }
  if (found.length > 0) {
    const seen = new Set<string>();
    const errors = found
      .sort((a, b) => SHEETS.indexOf(a.sheet as SheetName) - SHEETS.indexOf(b.sheet as SheetName) || a.row - b.row)
      .filter((e) => !seen.has(`${e.sheet}:${e.row}`) && seen.add(`${e.sheet}:${e.row}`));
    return { matched: true, errors };
  }
  if (!("draft" in result)) return { matched: false };

  // The draft's lines are the generated text's; its sources are the workbook's rows.
  const ids = (ranges: Src[]) =>
    toRanges(ranges.flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, k) => lines[from + k - 1]?.entry?.id ?? [])).flat());
  const draft = result.draft;
  for (const goal of draft.goals) {
    goal.src = ids(goal.src);
    goal.noteSrc = ids(goal.noteSrc);
    for (const part of [...goal.phases, ...goal.months, ...goal.commitments]) part.src = ids(part.src);
    for (const task of goal.tasks) {
      task.src = ids(task.src);
      task.noteSrc = ids(task.noteSrc);
      for (const child of task.children) {
        child.src = ids(child.src);
        child.noteSrc = ids(child.noteSrc);
      }
    }
  }
  return { matched: true, draft, source: { kind: "rows", lines: null } };
}

// The parser's keyword for a commitment with no amount: grammar, like the dates, not interface copy.
const TAP = "toque";

// `say` reads `import.template.workbook.*`: the example's words are the interface's, the grammar is not.
export async function templateWorkbook(say: (key: string) => string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const w = (key: string) => say(`template.workbook.${key}`);
  const goal = w("evalsName");
  const rows: Record<SheetName, (string | null)[][]> = {
    Metas: [
      [w("careerName"), null, "2028-10-01", null, null, null, w("careerNote")],
      [w("appliedName"), w("careerName"), "2027-10-01", null, null, null, null],
      [goal, w("appliedName"), "2027-03-01", w("evalsMeasure"), w("evalsUnit"), w("evalsRhythm"), w("evalsNote")],
      [w("readName"), null, null, w("readMeasure"), w("readUnit"), w("readRhythm"), null],
    ],
    Fases: [[goal, "2026-10-01", "2026-12-31", goal]],
    Meses: [[goal, "2026-10", w("monthAmountOct")], [goal, "2026-11", w("monthAmountNov")]],
    Compromisos: [
      [goal, w("technicalName"), w("technicalCadence"), w("technicalAmount")],
      [goal, w("passiveName"), w("everyDay"), TAP],
      [w("readName"), w("readName"), w("everyDay"), w("readAmount")],
    ],
    Tareas: [
      [goal, "2026-10", w("bookTask"), null, w("bookAmount"), null],
      [goal, "2026-10", w("tutorTask"), null, null, w("tutorNote")],
      [goal, "2026-10", null, w("pickChild"), w("pickAmount"), w("pickNote")],
      [goal, "2026-10", null, w("sessionsChild"), w("sessionsAmount"), null],
    ],
  };
  for (const name of SHEETS) {
    const sheet = wb.addWorksheet(name);
    if (name === "Metas") sheet.addRow([TEMPLATE_HEADER]);
    const header = sheet.addRow([...HEADERS[name]]);
    header.font = { bold: true };
    for (const row of rows[name]) sheet.addRow(row);
    sheet.columns.forEach((column) => {
      column.width = 24;
      column.alignment = { vertical: "top", wrapText: true };
    });
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
