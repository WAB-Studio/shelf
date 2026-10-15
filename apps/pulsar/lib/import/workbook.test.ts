import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ExcelJS from "exceljs";
import { createTranslator } from "next-intl";

import { coverage } from "./coverage";
import { parseTemplate, TEMPLATE_HEADER } from "./template";
import { readWorkbook, templateWorkbook, WORKBOOK_NAME } from "./workbook";

const catalogue = JSON.parse(readFileSync(new URL("../../messages/es/import.json", import.meta.url), "utf8"));
const say = (key: string) =>
  (createTranslator({ locale: "es", messages: { import: catalogue }, namespace: "import" }) as unknown as (k: string) => string)(key);

const DOC = readFileSync(new URL("../../../../docs/pulsar/PLANTILLA.md", import.meta.url), "utf8");
const DOC_EXAMPLE = /```\n([\s\S]*?)\n```/.exec(DOC)![1];

const HEADERS = {
  Metas: ["nombre", "dentro de", "horizonte", "medida", "unidad", "ritmo", "nota"],
  Fases: ["meta", "desde", "hasta", "objetivo"],
  Meses: ["meta", "mes", "monto"],
  Compromisos: ["meta", "nombre", "cadencia", "toque o monto"],
  Tareas: ["meta", "mes", "tarea", "sub-tarea", "monto", "nota"],
} as const;

type Rows = Partial<Record<keyof typeof HEADERS, unknown[][]>>;

// A workbook of the template's shape with only the rows a test names.
async function book(rows: Rows, mark: string = TEMPLATE_HEADER): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, headers] of Object.entries(HEADERS)) {
    const sheet = wb.addWorksheet(name);
    if (name === "Metas") sheet.addRow([mark]);
    sheet.addRow([...headers]);
    for (const row of rows[name as keyof typeof HEADERS] ?? []) sheet.addRow(row);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

// The lone goal every small test hangs its rows on.
const GOAL = ["Meta", null, "2027-01-01", null, null, null, null];
const HOURS = ["Meta", null, "2027-01-01", "estudio", "horas", null, null];

const strip = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === "src" || key === "noteSrc" ? undefined : v)));

async function read(bytes: Uint8Array) {
  const result = await readWorkbook(bytes);
  assert.equal(result.matched, true);
  return result as Extract<typeof result, { matched: true }>;
}

async function draftOf(bytes: Uint8Array) {
  const result = await read(bytes);
  assert.ok("draft" in result, JSON.stringify(result));
  return result.draft;
}

test("the workbook's name is the file the app hands out", () => {
  assert.equal(WORKBOOK_NAME, "plantilla-goallog.xlsx");
});

test("the delivered workbook, read back, is the draft of PLANTILLA.md's example", async () => {
  const expected = parseTemplate(DOC_EXAMPLE);
  assert.ok(expected.matched && "draft" in expected);
  const draft = await draftOf(await templateWorkbook(say));
  assert.deepEqual(strip(draft), strip(expected.draft));
});

test("the delivered workbook has the mark in Metas!A1 and its headers where the document says", async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await templateWorkbook(say)) as never);
  assert.deepEqual(wb.worksheets.map((s) => s.name), Object.keys(HEADERS));
  assert.equal(wb.getWorksheet("Metas")!.getCell("A1").value, TEMPLATE_HEADER);
  const header = (name: string, row: number) =>
    (wb.getWorksheet(name)!.getRow(row).values as unknown[]).slice(1).map(String);
  assert.deepEqual(header("Metas", 2), [...HEADERS.Metas]);
  for (const name of ["Fases", "Meses", "Compromisos", "Tareas"] as const) assert.deepEqual(header(name, 1), [...HEADERS[name]]);
});

test("the workbook loses nothing: its coverage counts 0 rows out, as rows", async () => {
  const result = await read(await templateWorkbook(say));
  assert.ok("draft" in result);
  const counted = coverage(result.draft, result.source, new Set(), new Set());
  assert.equal(result.source.kind, "rows");
  assert.equal(counted.kind, "rows");
  assert.equal(counted.out, 0);
  assert.ok(counted.plan > 0);
});

test("every row of Tareas is counted: a task, its notes and its sub-tasks", async () => {
  const bytes = await book({
    Metas: [GOAL],
    Tareas: [
      ["Meta", "2026-10", "Tutor", null, null, "una\ndos"],
      ["Meta", "2026-10", null, "Elegir", null, "nota hija"],
    ],
  });
  const result = await read(bytes);
  assert.ok("draft" in result);
  const counted = coverage(result.draft, result.source, new Set(), new Set());
  assert.equal(counted.out, 0);
  assert.equal(counted.plan + counted.notes, 3);
});

test("a broken row is named by its sheet and its row number, header included", async () => {
  const result = await readWorkbook(
    await book({ Metas: [HOURS], Meses: [["Meta", "2026-10", "12 h"], ["Meta", "2026-11", "1 h"], ["Meta", "2026-13", "37 h"]] }),
  );
  assert.deepEqual(result, { matched: true, errors: [{ sheet: "Meses", row: 4, expected: "import.errors.form.monthReal" }] });
});

test("every broken row comes at once, in sheet order and then row order", async () => {
  const result = await readWorkbook(
    await book({
      Metas: [HOURS],
      Meses: [["Meta", "2026-13", "37 h"]],
      Tareas: [["Meta", "2026-10", "Bien", null, null, null], ["Meta", "2026-14", "Rota", null, null, null]],
    }),
  );
  assert.ok("errors" in result);
  assert.deepEqual(result.errors.map((e) => [e.sheet, e.row]), [["Meses", 2], ["Tareas", 3]]);
});

test("two broken rows of one sheet come in row order", async () => {
  const result = await readWorkbook(
    await book({ Metas: [HOURS], Meses: [["Meta", "2026-13", "1 h"], ["Meta", "2026-10", "1 h"], ["Meta", "2026-14", "1 h"]] }),
  );
  assert.ok("errors" in result);
  assert.deepEqual(result.errors.map((e) => [e.sheet, e.row]), [["Meses", 2], ["Meses", 4]]);
});

test("a row naming a goal that is not in Metas is a broken row of its own sheet", async () => {
  const result = await readWorkbook(await book({ Metas: [GOAL], Fases: [["Otra", "2026-01-01", "2026-02-01", "x"]] }));
  assert.ok("errors" in result);
  assert.deepEqual(result.errors.map((e) => [e.sheet, e.row]), [["Fases", 2]]);
});

test("a workbook without the mark in Metas!A1 does not match", async () => {
  assert.deepEqual(await readWorkbook(await book({ Metas: [GOAL] }, "otra cosa")), { matched: false });
});

test("a workbook with the five sheets and no mark is not matched by its sheet names", async () => {
  const wb = new ExcelJS.Workbook();
  for (const [name, headers] of Object.entries(HEADERS)) wb.addWorksheet(name).addRow([...headers]);
  assert.deepEqual(await readWorkbook(new Uint8Array(await wb.xlsx.writeBuffer())), { matched: false });
});

test("bytes that are not a workbook do not match", async () => {
  assert.deepEqual(await readWorkbook(new TextEncoder().encode("pulsar · plantilla 2")), { matched: false });
});

test("a broken header or a missing sheet cuts the read and says only that", async () => {
  const wb = new ExcelJS.Workbook();
  const metas = wb.addWorksheet("Metas");
  metas.addRow([TEMPLATE_HEADER]);
  metas.addRow([...HEADERS.Metas]);
  metas.addRow(GOAL);
  wb.addWorksheet("Fases").addRow(["meta", "desde", "hasta", "otro"]);
  wb.addWorksheet("Meses").addRow([...HEADERS.Meses]).worksheet.addRow(["Meta", "2026-13", "1 h"]);
  const result = await readWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
  assert.ok("errors" in result);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].sheet, "Fases");
  assert.equal(result.errors[0].row, 1);
});

test("a date cell as the horizon is the civil day, whatever the zone", async () => {
  const draft = await draftOf(await book({ Metas: [["Meta", null, new Date(Date.UTC(2028, 9, 1)), null, null, null, null]] }));
  assert.equal(draft.goals[0].horizon, "2028-10-01");
});

test("a month stored as a date is AAAA-MM", async () => {
  const draft = await draftOf(
    await book({
      Metas: [HOURS],
      Meses: [["Meta", new Date(Date.UTC(2026, 9, 1)), "12 h"]],
      Tareas: [["Meta", new Date(Date.UTC(2026, 10, 1)), "Algo", null, null, null]],
    }),
  );
  assert.equal(draft.goals[0].months[0].month, "2026-10");
  assert.equal(draft.goals[0].tasks[0].month, "2026-11");
});

test("phase dates stored as dates are AAAA-MM-DD", async () => {
  const draft = await draftOf(
    await book({ Metas: [GOAL], Fases: [["Meta", new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 11, 31)), "Algo"]] }),
  );
  assert.deepEqual([draft.goals[0].phases[0].startsOn, draft.goals[0].phases[0].endsOn], ["2026-10-01", "2026-12-31"]);
});

test("a bare number in the amount of a goal in hours is hours", async () => {
  const draft = await draftOf(
    await book({
      Metas: [HOURS],
      Meses: [["Meta", "2026-10", 12]],
      Tareas: [["Meta", "2026-10", "Algo", null, 1.5, null]],
    }),
  );
  assert.equal(draft.goals[0].months[0].amount, 720);
  assert.equal(draft.goals[0].tasks[0].estimate, 90);
});

test("a bare number in a goal measured in minutes is minutes; in another unit, that number", async () => {
  const minutes = await draftOf(await book({ Metas: [["Meta", null, "2027-01-01", "estudio", "minutos", null, null]], Meses: [["Meta", "2026-10", 30]] }));
  assert.equal(minutes.goals[0].months[0].amount, 30);
  const km = await draftOf(await book({ Metas: [["Meta", null, "2027-01-01", "correr", "km", null, null]], Meses: [["Meta", "2026-10", 8]] }));
  assert.equal(km.goals[0].months[0].amount, 8);
});

test("a note with line breaks is a note of two lines", async () => {
  const draft = await draftOf(
    await book({
      Metas: [["Meta", null, "2027-01-01", null, null, null, "a\nb"]],
      Tareas: [["Meta", "2026-10", "Algo", null, null, "c\r\nd"]],
    }),
  );
  assert.equal(draft.goals[0].note, "a\nb");
  assert.equal(draft.goals[0].tasks[0].note, "c\nd");
});

test("the column «dentro de» makes the parent", async () => {
  const draft = await draftOf(
    await book({ Metas: [["Madre", null, "2028-01-01", null, null, null, null], ["Hija", "Madre", "2027-01-01", null, null, null, null]] }),
  );
  assert.deepEqual(draft.goals.map((g) => [g.name, g.parent]), [["Madre", null], ["Hija", "g1"]]);
});

test("a sub-task row belongs to the last task of its month and goal, and blank rows are skipped", async () => {
  const draft = await draftOf(
    await book({
      Metas: [GOAL, [], ],
      Tareas: [
        ["Meta", "2026-10", "Uno", null, null, null],
        ["Meta", "2026-11", "Dos", null, null, null],
        [],
        ["Meta", "2026-10", null, "Hija de uno", null, null],
      ],
    }),
  );
  assert.deepEqual(draft.goals[0].tasks.map((t) => [t.name, t.children.map((c) => c.name)]), [["Uno", ["Hija de uno"]], ["Dos", []]]);
});

test("a sub-task with no task of its month before it is a broken row", async () => {
  const result = await readWorkbook(await book({ Metas: [GOAL], Tareas: [["Meta", "2026-10", null, "Huérfana", null, null]] }));
  assert.ok("errors" in result);
  assert.deepEqual(result.errors.map((e) => [e.sheet, e.row]), [["Tareas", 2]]);
});

test("a commitment row reads its cadence and its tap", async () => {
  const draft = await draftOf(await book({ Metas: [GOAL], Compromisos: [["Meta", "Inglés", "cada día", "toque"]] }));
  assert.equal(draft.goals[0].commitments[0].satisfaction, "tap");
});

// ---- 903: survivors of the tren-i1 mutator in the workbook reader.

async function errorsOf(bytes: Uint8Array) {
  const result = await read(bytes);
  assert.ok("errors" in result, JSON.stringify(result));
  return result.errors.map((e) => [e.sheet, e.row, e.expected]);
}

test("903: a bare number is hours in a goal in hours and minutes in a goal in minutes; a decimal point reads", async () => {
  const hours = await draftOf(await book({ Metas: [["Meta", null, "2027-01-01", "estudio", "horas", 2, null]], Meses: [["Meta", "2026-10", 12], ["Meta", "2026-11", "1.5"]] }));
  assert.equal(hours.goals[0].rhythm, 120);
  assert.deepEqual(hours.goals[0].months.map((m) => m.amount), [720, 90]);
  const minutes = await draftOf(await book({ Metas: [["Meta", null, "2027-01-01", "estudio", "minutos", 45, null]], Meses: [["Meta", "2026-10", 30]] }));
  assert.equal(minutes.goals[0].rhythm, 45);
  assert.equal(minutes.goals[0].months[0].amount, 30);
});

test("903: the headers match whatever their case or spaces", async () => {
  const wb = new ExcelJS.Workbook();
  for (const [name, headers] of Object.entries(HEADERS)) {
    const sheet = wb.addWorksheet(name);
    if (name === "Metas") sheet.addRow([TEMPLATE_HEADER]);
    sheet.addRow(headers.map((h) => `  ${h.toUpperCase()} `));
    if (name === "Metas") sheet.addRow([...GOAL]);
  }
  const draft = await draftOf(new Uint8Array(await wb.xlsx.writeBuffer()));
  assert.equal(draft.goals[0].name, "Meta");
});

test("903: a book with no goal row answers the first row of Metas; a broken header answers its own row", async () => {
  assert.deepEqual(await errorsOf(await book({})), [["Metas", 3, "import.errors.form.goal"]]);
  const wb = new ExcelJS.Workbook();
  for (const [name, headers] of Object.entries(HEADERS)) {
    const sheet = wb.addWorksheet(name);
    if (name === "Metas") sheet.addRow([TEMPLATE_HEADER]);
    sheet.addRow(name === "Meses" ? ["meta", "otro", "monto"] : [...headers]);
  }
  assert.deepEqual(await errorsOf(new Uint8Array(await wb.xlsx.writeBuffer())), [["Meses", 1, "import.errors.form.month"]]);
  const metas = new ExcelJS.Workbook();
  for (const [name, headers] of Object.entries(HEADERS)) {
    const sheet = metas.addWorksheet(name);
    if (name === "Metas") sheet.addRow([TEMPLATE_HEADER]);
    sheet.addRow(name === "Metas" ? ["otro", ...headers.slice(1)] : [...headers]);
  }
  assert.deepEqual(await errorsOf(new Uint8Array(await metas.xlsx.writeBuffer())), [["Metas", 2, "import.errors.form.goal"]]);
});

test("903: a goal row with no name and a row naming no goal are errors on their own rows", async () => {
  assert.deepEqual(await errorsOf(await book({ Metas: [[null, null, "2027-01-01", null, null, null, null]] })), [["Metas", 3, "import.errors.form.goal"]]);
  assert.deepEqual(
    await errorsOf(await book({ Metas: [[...GOAL]], Fases: [["Otra", "2026-10-01", "2026-12-31", "Fase"]] })),
    [["Fases", 2, "import.errors.form.phase"]],
  );
});

test("903: errors come by sheet in the book's order, then by row, each row once", async () => {
  const bytes = await book({
    Metas: [[...GOAL]],
    Fases: [["Meta", "mal", "mal", "Fase"], ["Meta", "mal", "mal", "Otra"]],
    Tareas: [["Meta", "2026-13", "T", null, null, null]],
  });
  assert.deepEqual(await errorsOf(bytes), [
    ["Fases", 2, "import.errors.form.phase"],
    ["Fases", 3, "import.errors.form.phase"],
    ["Tareas", 2, "import.errors.form.monthReal"],
  ]);
  const twice = await book({ Metas: [["Meta", null, "no-fecha", "m", "", "xx", null]] });
  const rows = (await errorsOf(twice)).map((e) => `${e[0]}:${e[1]}`);
  assert.deepEqual(rows, [...new Set(rows)]);
});

test("903: the draft's parts name the rows they came from", async () => {
  const draft = await draftOf(
    await book({
      Metas: [[...HOURS]],
      Fases: [["Meta", "2026-10-01", "2026-12-31", "Fase"]],
      Meses: [["Meta", "2026-10", "2 h"]],
      Compromisos: [["Meta", "Leer", "cada día", "toque"]],
      Tareas: [["Meta", "2026-10", "Tarea", null, "1 h", null]],
    }),
  );
  const [goal] = draft.goals;
  assert.deepEqual(goal.src, [{ from: 1, to: 1 }]);
  assert.deepEqual(goal.phases[0].src, [{ from: 2, to: 2 }]);
  assert.deepEqual(goal.months[0].src, [{ from: 3, to: 3 }]);
  assert.deepEqual(goal.commitments[0].src, [{ from: 4, to: 4 }]);
  assert.deepEqual(goal.tasks[0].src, [{ from: 5, to: 5 }]);
});

test("903: a blank row in a sheet is not a row", async () => {
  const draft = await draftOf(await book({ Metas: [[...HOURS]], Meses: [["Meta", "2026-10", "2 h"], [null, null, null], ["Meta", "2026-11", "3 h"]] }));
  assert.deepEqual(draft.goals[0].months.map((m) => m.src), [[{ from: 2, to: 2 }], [{ from: 3, to: 3 }]]);
});

test("915 an empty horizon cell is a goal with no end", async () => {
  const draft = await draftOf(await book({ Metas: [["Meta", null, null, "estudio", "horas", null, null]] }));
  assert.equal(draft.goals[0].horizon, null);
});

test("915 a rhythm in another unit reads as a whole number of it", async () => {
  const draft = await draftOf(await book({ Metas: [["Meta", null, null, "lectura", "páginas", 40, null]] }));
  assert.equal(draft.goals[0].rhythm, 40);
  assert.equal(draft.goals[0].horizon, null);
});

test("the delivered workbook's example rows carry exactly this text", async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await templateWorkbook(say)) as never);
  const rows = (name: string) => {
    const sheet = wb.getWorksheet(name)!;
    const out: unknown[][] = [];
    sheet.eachRow((row, n) => {
      if (n > (name === "Metas" ? 2 : 1)) out.push(Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).value ?? null));
    });
    return out;
  };
  const goal = "Evals y harness";
  assert.deepEqual(rows("Metas"), [
    ["Carrera en IA", null, "2028-10-01", null, null, null, "Lo que busco en dos años.\nUn ritmo que pueda sostener."],
    ["IA aplicada", "Carrera en IA", "2027-10-01", null, null, null, null],
    [goal, "IA aplicada", "2027-03-01", "horas de estudio", "minutos", "12 h", "Empezar por lo que ya sé medir."],
    ["Leer", null, null, "lectura", "páginas", "40 páginas", null],
  ]);
  assert.deepEqual(rows("Fases"), [[goal, "2026-10-01", "2026-12-31", goal]]);
  assert.deepEqual(rows("Meses"), [[goal, "2026-10", "12 h"], [goal, "2026-11", "20 h"]]);
  assert.deepEqual(rows("Compromisos"), [
    [goal, "Tema técnico", "martes y jueves", "2 h"],
    [goal, "Inglés pasivo", "cada día", "toque"],
    ["Leer", "Leer", "cada día", "10 páginas"],
  ]);
  assert.deepEqual(rows("Tareas"), [
    [goal, "2026-10", "Leer AI Engineering cap. 1–4", null, "4 h", null],
    [goal, "2026-10", "Tutor", null, null, "Preguntar por la tarifa por hora.\nPedir una clase de prueba antes de pagar."],
    [goal, "2026-10", null, "Elegir tutor", "1 h", "Comparar tres perfiles."],
    [goal, "2026-10", null, "Sesiones 1–4", "6 h", null],
  ]);
});

// An archive of empty files whose central directory declares the sizes the test names.
function zipDeclaring(sizes: number[]): Uint8Array {
  const names = sizes.map((_, i) => Buffer.from(`f${i}.xml`));
  const central = Buffer.concat(
    sizes.map((size, i) => {
      const h = Buffer.alloc(46 + names[i].length);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt32LE(size, 24);
      h.writeUInt16LE(names[i].length, 28);
      names[i].copy(h, 46);
      return h;
    }),
  );
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sizes.length, 8);
  end.writeUInt16LE(sizes.length, 10);
  end.writeUInt32LE(central.length, 12);
  return new Uint8Array(Buffer.concat([central, end]));
}

test("zipTooBig: a template passes, an archive that declares past the cap or holds too many entries does not", async () => {
  const { zipTooBig } = await import("./workbook");
  assert.equal(zipTooBig(await templateWorkbook(say)), false);
  const bomb = zipDeclaring([60 * 1024 * 1024]);
  assert.equal(zipTooBig(bomb), true);
  assert.deepEqual(await readWorkbook(bomb), { matched: false });
  assert.equal(zipTooBig(zipDeclaring(Array(201).fill(1))), true);
  assert.equal(zipTooBig(zipDeclaring(Array(200).fill(1))), false);
});
