import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { beforeEach, mock, test } from "node:test";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { parseAmount } from "@/lib/money";

// M2 (RF-51, RF-52). The real pipeline runs, over a real .xlsx; the database read and the request
// locale are doubled at module resolution, and the scope is whatever each test seeds.

const messages = JSON.parse(readFileSync(new URL("../../messages/en.json", import.meta.url), "utf8")) as {
  data: { sheets: Record<string, string>; columns: Record<string, string> };
};

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHECKING = { id: UUID(1), name: "Checking", externalRef: "acc-1", ownerUserId: UUID(99), groupId: null, settlementCurrency: "COP" };
const SAVINGS = { id: UUID(2), name: "Savings", externalRef: "acc-2", ownerUserId: UUID(99), groupId: null, settlementCurrency: "COP" };
const FOOD = { id: UUID(11), name: "Food", externalRef: "cat-1", ownerUserId: UUID(99), groupId: null, kind: "expense" };

type Scope = {
  caller: { userId: string; groupId: string | null };
  accounts: unknown[];
  categories: unknown[];
  existingRefs: Record<"accounts" | "members" | "categories" | "recurringRules" | "transactions", Set<string>>;
};
let scope: Scope;
const freshScope = (): Scope => ({
  caller: { userId: UUID(99), groupId: null },
  accounts: [CHECKING, SAVINGS],
  categories: [FOOD],
  existingRefs: {
    accounts: new Set(["acc-1", "acc-2"]),
    members: new Set(),
    categories: new Set(["cat-1"]),
    recurringRules: new Set(),
    transactions: new Set(),
  },
});

const double = {
  readImportScope: async () => scope,
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => {
    const [group, name] = key.split(".");
    return (messages.data as unknown as Record<string, Record<string, string>>)[group][name];
  },
};
(globalThis as unknown as { __importDouble: typeof double }).__importDouble = double;
const D = "globalThis.__importDouble";
const DOUBLES: Record<string, string> = {
  "server-only": "export {};",
  "@/db/queries/import-preview": `export const readImportScope = () => ${D}.readImportScope();`,
  "next-intl/server": `export const getLocale = () => ${D}.getLocale(); export const getTranslations = (...a) => ${D}.getTranslations(...a);`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in DOUBLES) return { url: `double:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("double:")) return { format: "module", source: DOUBLES[url.slice(7)], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const MIB = 1024 * 1024;
const COLUMNS = ["externalRef", "fromAccount", "toAccount", "amount", "currency", "category", "occurredAt", "description", "adjustment"];

type Cells = Partial<Record<(typeof COLUMNS)[number], string | number | null>>;

async function book(transactions: Cells[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(messages.data.sheets.transactions);
  sheet.addRow(COLUMNS.map((key) => messages.data.columns[key]));
  for (const row of transactions) sheet.addRow(COLUMNS.map((key) => row[key] ?? null));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const spend = (amount: number, description: string): Cells => ({
  fromAccount: "Checking",
  amount,
  category: "Food",
  occurredAt: "2026-01-10",
  description,
});

const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function run(bytes: Uint8Array) {
  const { runImportPipeline } = await import("./import-pipeline");
  const result = await runImportPipeline({ buffer: buffer(bytes) });
  return result.perEntity.find((e) => e.entity === "transactions")!.rows;
}

beforeEach(() => {
  scope = freshScope();
});

// ---- blank references -------------------------------------------------------------------------

test("a row with a blank reference gets the imp: key, 32 hex after the prefix", async () => {
  const rows = await run(await book([spend(1000, "a")]));
  assert.match(rows[0].externalRef ?? "", /^imp:[0-9a-f]{32}$/);
  assert.deepEqual(rows[0].errors, []);
});

test("the same file imported twice carries the same keys on its three blank-reference rows", async () => {
  const file = await book([spend(1000, "a"), spend(2000, "b"), spend(3000, "c")]);
  const first = (await run(file)).map((r) => r.externalRef);
  const second = (await run(file)).map((r) => r.externalRef);
  assert.equal(first.length, 3);
  assert.equal(new Set(first).size, 3);
  assert.deepEqual(second, first);
});

test("the same content in a different file (rebuilt, not the same bytes) keys the same", async () => {
  const rows = [spend(1000, "a"), spend(2000, "b")];
  const a = (await run(await book(rows))).map((r) => r.externalRef);
  const b = (await run(await book(rows))).map((r) => r.externalRef);
  for (const key of a) assert.match(key ?? "", /^imp:[0-9a-f]{32}$/);
  assert.deepEqual(b, a);
});

test("two identical blank-reference rows in one file get two distinct keys", async () => {
  const rows = await run(await book([spend(1000, "twin"), spend(1000, "twin"), spend(1000, "twin")]));
  assert.equal(new Set(rows.map((r) => r.externalRef)).size, 3);
  for (const row of rows) assert.match(row.externalRef ?? "", /^imp:[0-9a-f]{32}$/);
});

test("twins keep their keys when the file is read again", async () => {
  const file = await book([spend(1000, "twin"), spend(1000, "twin")]);
  const first = (await run(file)).map((r) => r.externalRef);
  assert.equal(new Set(first).size, 2);
  assert.deepEqual((await run(file)).map((r) => r.externalRef), first);
});

test("changing one amount changes that row's key and none of the others", async () => {
  const before = (await run(await book([spend(1000, "a"), spend(2000, "b"), spend(3000, "c")]))).map((r) => r.externalRef);
  const after = (await run(await book([spend(1000, "a"), spend(2500, "b"), spend(3000, "c")]))).map((r) => r.externalRef);
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.equal(after[2], before[2]);
});

test("a row's key does not depend on where it sits in the sheet", async () => {
  const alone = (await run(await book([spend(2000, "b")])))[0].externalRef;
  const later = (await run(await book([spend(1000, "a"), spend(2000, "b")])))[1].externalRef;
  assert.match(alone ?? "", /^imp:[0-9a-f]{32}$/);
  assert.equal(later, alone);
});

test("a row that carries its own reference keeps it untouched", async () => {
  const rows = await run(await book([{ ...spend(1000, "a"), externalRef: "mine-1" }]));
  assert.equal(rows[0].externalRef, "mine-1");
});

test("second import: the rows whose keys were committed are updates, never new, even when the sheet shifts", async () => {
  const rows = [spend(1000, "a"), spend(2000, "b"), spend(2000, "b")];
  const first = await run(await book(rows));
  assert.deepEqual(first.map((r) => r.status), ["new", "new", "new"]);

  scope.existingRefs.transactions = new Set(first.map((r) => r.externalRef as string));
  const again = await run(await book(rows));
  assert.deepEqual(again.map((r) => r.status), ["update", "update", "update"]);

  const shifted = await run(await book([spend(500, "brand new"), ...rows]));
  assert.deepEqual(shifted.map((r) => r.status), ["new", "update", "update", "update"]);
});

// ---- the transfer's category ------------------------------------------------------------------

for (const [label, category] of [
  ["a category the account scope has", "Food"],
  ["a name no category has", "Nothing like it"],
  ["a name past the 80-character bound", "x".repeat(120)],
] as const) {
  test(`a backup transfer row holding ${label} in its category cell passes and books no category and no split`, async () => {
    const rows = await run(
      await book([{ fromAccount: "Checking", toAccount: "Savings", amount: 5000, category, occurredAt: "2026-01-10", description: "move" }]),
    );
    assert.deepEqual(rows[0].errors, []);
    const object = rows[0].object as { fromAccountId: string; toAccountId: string; splits: unknown[]; categoryId?: unknown };
    assert.equal(object.fromAccountId, CHECKING.id);
    assert.equal(object.toAccountId, SAVINGS.id);
    assert.deepEqual(object.splits, []);
    assert.ok(object.categoryId == null);
  });
}

// Mutation: build the single split for a transfer too. The row guard already blanks the category cell of a
// two-account row, so resolving it first, or checking its kind, cannot be seen from outside: the split is.
test("a backup transfer row holding an income category passes: the cell is never read for its kind", async () => {
  scope.categories = [...scope.categories, { id: UUID(12), name: "Salary", externalRef: "cat-2", ownerUserId: UUID(99), groupId: null, kind: "income" }];
  scope.existingRefs.categories = new Set(["cat-1", "cat-2"]);
  const rows = await run(
    await book([{ fromAccount: "Checking", toAccount: "Savings", amount: 5000, category: "Salary", occurredAt: "2026-01-10", description: "move" }]),
  );
  assert.deepEqual(rows[0].errors, []);
  assert.deepEqual((rows[0].object as { splits: unknown[] }).splits, []);
});

test("an expense row keeps its category and its single split", async () => {
  const rows = await run(await book([spend(1000, "a")]));
  const object = rows[0].object as { splits: { categoryId: string }[] };
  assert.deepEqual(object.splits.map((s) => s.categoryId), [FOOD.id]);
});

// ---- a purchase in dollars on a peso card (RF-142, RF-122, RF-123) -----------------------------

const CARD = { id: UUID(3), name: "Tarjeta COP", externalRef: "acc-3", ownerUserId: UUID(99), groupId: null, settlementCurrency: "COP" };

type ForeignCells = Record<string, string | number | boolean | null | undefined>;
const FOREIGN_COLUMNS = [...COLUMNS, "counterAmount", "counterIsEstimate"] as const;

async function bookWith(columns: readonly string[], transactions: Record<string, string | number | boolean | null | undefined>[]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(messages.data.sheets.transactions);
  sheet.addRow(columns.map((key) => messages.data.columns[key]));
  for (const row of transactions) sheet.addRow(columns.map((key) => row[key] ?? null));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const bookForeign = (rows: ForeignCells[]) => bookWith(FOREIGN_COLUMNS, rows);

const dollarPurchase = (over: ForeignCells = {}): ForeignCells => ({
  fromAccount: "Tarjeta COP",
  amount: 25,
  currency: "USD",
  counterAmount: 105000,
  counterIsEstimate: true,
  category: "Food",
  occurredAt: "2026-01-10",
  description: "dollar purchase",
  ...over,
});

type Parsed = { currency?: string; amount?: string; amountCents?: number; counterAmount?: string | null; counterAmountCents?: number | null; counterIsEstimate?: boolean };
const centsOf = (cents: number | null | undefined, text: string | null | undefined) =>
  cents ?? (text == null ? null : parseAmount(text));

beforeEach(() => {
  scope.accounts = [CHECKING, SAVINGS, CARD];
  scope.existingRefs.accounts = new Set(["acc-1", "acc-2", "acc-3"]);
});

test("RF-142: USD 25 on a peso card with 105.000 estimated parses in dollars, never converted, with its peso amount and the mark", async () => {
  const rows = await run(await bookForeign([dollarPurchase()]));
  assert.deepEqual(rows[0].errors, []);
  const object = rows[0].object as Parsed;
  assert.equal(object.currency, "USD");
  assert.equal(centsOf(object.amountCents, object.amount), 2500);
  assert.equal(centsOf(object.counterAmountCents, object.counterAmount), 10_500_000);
  assert.equal(object.counterIsEstimate, true);
});

test("RF-123: a blank estimate cell on a dollar purchase means billed, not estimated", async () => {
  const rows = await run(await bookForeign([dollarPurchase({ counterIsEstimate: null })]));
  assert.deepEqual(rows[0].errors, []);
  assert.equal((rows[0].object as Parsed).counterIsEstimate, false);
});

test("RF-122: a dollar purchase on a peso card without its peso amount is refused with the currency words it was refused with", async () => {
  const rows = await run(await bookForeign([dollarPurchase({ counterAmount: null, counterIsEstimate: null })]));
  assert.equal(rows[0].object, null);
  assert.deepEqual(rows[0].errors.map((e) => e.key), ["transactions.errors.currencyMismatch"]);
  assert.equal(rows[0].errors[0].column, "currency");
});

test("RF-122: a peso row on a peso card carrying a second amount is refused as counterAmountForbidden, at its column", async () => {
  const rows = await run(await bookForeign([dollarPurchase({ currency: "COP", amount: 105000 })]));
  assert.equal(rows[0].object, null);
  assert.deepEqual(rows[0].errors.map((e) => [e.key, e.column]), [["transactions.errors.counterAmountForbidden", "counterAmount"]]);
});

test("RF-122: a peso row with the currency cell blank and a second amount is refused too", async () => {
  const rows = await run(await bookForeign([dollarPurchase({ currency: null, amount: 105000 })]));
  assert.equal(rows[0].object, null);
  assert.ok(rows[0].errors.some((e) => e.key === "transactions.errors.counterAmountForbidden"));
});

test("RF-52: a sheet written before the two columns existed parses as it did, a peso row with no second amount", async () => {
  const old = await bookWith(COLUMNS, [{ ...spend(1000, "old"), externalRef: "old-1", currency: "COP" }, spend(2000, "older")]);
  const rows = await run(old);
  assert.deepEqual(rows.map((r) => r.errors), [[], []]);
  for (const row of rows) {
    const object = row.object as Parsed;
    assert.equal(object.counterAmount ?? null, null);
    assert.equal(object.counterAmountCents ?? null, null);
  }
  assert.equal(centsOf((rows[0].object as Parsed).amountCents, (rows[0].object as Parsed).amount), 100_000);
});

test("RF-52: a foreign row keeps its reference, so importing the file twice updates it instead of duplicating", async () => {
  const file = await bookForeign([dollarPurchase({ externalRef: "usd-1" })]);
  const first = (await run(file))[0];
  assert.deepEqual(first.errors, []);
  assert.equal(first.status, "new");
  scope.existingRefs.transactions = new Set(["usd-1"]);
  const again = (await run(file))[0];
  assert.deepEqual(again.errors, []);
  assert.equal(again.status, "update");
});

// ---- the zip guard ----------------------------------------------------------------------------

// Overwrites the size a directory entry (and its local header) declares.
function forgeSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = Buffer.from(zip);
  const end = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = out.readUInt16LE(end + 10);
  let at = out.readUInt32LE(end + 16);
  let patched = 0;
  for (let i = 0; i < entries; i++) {
    const nameLength = out.readUInt16LE(at + 28);
    if (out.subarray(at + 46, at + 46 + nameLength).toString() === name) {
      out.writeUInt32LE(size, at + 24);
      out.writeUInt32LE(size, out.readUInt32LE(at + 42) + 22);
      patched++;
    }
    at += 46 + nameLength + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  assert.equal(patched, 1);
  return new Uint8Array(out);
}

async function padded(base: Uint8Array, entries: Record<string, Buffer>, compression: "DEFLATE" | "STORE" = "DEFLATE") {
  const zip = await JSZip.loadAsync(base);
  for (const [name, data] of Object.entries(entries)) zip.file(name, data, { compression });
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression }));
}

const LOADED = "xlsx.load was reached";

// Replaces ExcelJS's loader by a probe that counts and stops, so a test sees whether the guard let the archive through.
async function withLoadProbe<T>(body: (calls: () => number) => Promise<T>): Promise<T> {
  const { default: Xlsx } = (await import("exceljs/lib/xlsx/xlsx.js")) as unknown as {
    default: { prototype: { load: (...args: unknown[]) => Promise<unknown> } };
  };
  const probe = mock.method(Xlsx.prototype, "load", async () => {
    throw new Error(LOADED);
  });
  try {
    return await body(() => probe.mock.callCount());
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
}

async function outcome(bytes: Uint8Array) {
  const { runImportPipeline } = await import("./import-pipeline");
  return runImportPipeline({ buffer: buffer(bytes) }).then(
    () => ({ ok: true as const }),
    (error: Error) => ({ ok: false as const, error }),
  );
}

test("forged directory: an entry that inflates 80 MiB under a directory saying 1 KB is refused with the pipeline's ActionError and xlsx.load never runs", async () => {
  const honest = await book([spend(1000, "a")]);
  const forged = forgeSize(await padded(honest, { "bomb.bin": Buffer.alloc(80 * MIB) }), "bomb.bin", 1024);
  await withLoadProbe(async (calls) => {
    const result = await outcome(forged);
    assert.equal(result.ok, false);
    assert.equal((result as { error: Error }).error.name, "ActionError", String((result as { error: Error }).error));
    assert.equal(calls(), 0, "ExcelJS never loads the archive");
  });
});

test("the inflated cap is 64 MiB: an archive of 60 MiB reaches the loader, one of 70 MiB does not", async () => {
  const honest = await book([spend(1000, "a")]);
  await withLoadProbe(async (calls) => {
    const under = await outcome(await padded(honest, { "pad.bin": Buffer.alloc(60 * MIB) }));
    assert.equal((under as { error?: Error }).error?.message, LOADED);
    assert.equal(calls(), 1);
    const over = await outcome(await padded(honest, { "pad.bin": Buffer.alloc(70 * MIB) }));
    assert.equal((over as { error?: Error }).error?.name, "ActionError");
    assert.equal(calls(), 1, "the 70 MiB archive never reached the loader");
  });
});

test("the entries cap is 200: 200 entries reach the loader, 201 do not", async () => {
  const honest = await book([spend(1000, "a")]);
  const base = Object.keys((await JSZip.loadAsync(honest)).files).length;
  const withEntries = (total: number) =>
    padded(honest, Object.fromEntries(Array.from({ length: total - base }, (_, i) => [`pad${i}.txt`, Buffer.from("x")])), "STORE");
  await withLoadProbe(async (calls) => {
    const at = await outcome(await withEntries(200));
    assert.equal((at as { error?: Error }).error?.message, LOADED);
    assert.equal(calls(), 1);
    const over = await outcome(await withEntries(201));
    assert.equal((over as { error?: Error }).error?.name, "ActionError");
    assert.equal(calls(), 1);
  });
});

test("the downloadable template, deflated by ExcelJS as it ships, reads through the guard", async () => {
  const { buildTemplate } = await import("./workbook");
  const wb = buildTemplate({
    labels: {
      sheetName: (entity) => messages.data.sheets[entity],
      columnHeader: (key) => messages.data.columns[key],
    },
    accountNames: ["Checking", "Savings"],
    categoryNames: ["Food"],
  });
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const { runImportPipeline } = await import("./import-pipeline");
  const result = await runImportPipeline({ buffer: buffer(bytes) });
  assert.deepEqual(result.totals, { new: 0, update: 0, error: 0 });
});

test("an honest workbook is read through, loader included", async () => {
  const rows = await run(await book([spend(1000, "a")]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].errors, []);
});

test("the entries fixture really holds the entry count it names", async () => {
  const honest = await book([spend(1000, "a")]);
  const base = Object.keys((await JSZip.loadAsync(honest)).files).length;
  const zip = await padded(honest, Object.fromEntries(Array.from({ length: 200 - base }, (_, i) => [`pad${i}.txt`, Buffer.from("x")])), "STORE");
  const end = zip.length - 22;
  assert.equal(new DataView(zip.buffer, zip.byteOffset).getUint16(end + 10, true), 200);
});
