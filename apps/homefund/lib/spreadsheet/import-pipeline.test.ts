import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { beforeEach, mock, test } from "node:test";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { maxAmountMinor, parseAmount } from "@/lib/money";

// M2 (RF-51, RF-52). The real pipeline runs, over a real .xlsx; the database read and the request
// locale are doubled at module resolution, and the scope is whatever each test seeds.

const messages = JSON.parse(readFileSync(new URL("../../messages/en.json", import.meta.url), "utf8")) as {
  data: { sheets: Record<string, string>; columns: Record<string, string> };
};

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHECKING = { id: UUID(1), name: "Checking", externalRef: "acc-1", ownerUserId: UUID(99), groupId: null, settlementCurrency: "COP", initialBalanceOn: "2026-01-01" };
const SAVINGS = { id: UUID(2), name: "Savings", externalRef: "acc-2", ownerUserId: UUID(99), groupId: null, settlementCurrency: "COP", initialBalanceOn: "2026-01-01" };
const FOOD = { id: UUID(11), name: "Food", externalRef: "cat-1", ownerUserId: UUID(99), groupId: null, kind: "expense" };
const TRIP = { id: UUID(21), name: "Trip", externalRef: "lab-1", ownerUserId: UUID(99), groupId: null };

type Scope = {
  caller: { userId: string; groupId: string | null };
  accounts: unknown[];
  categories: unknown[];
  labels: unknown[];
  goals: unknown[];
  existingRefs: Record<string, Set<string>>;
};
let scope: Scope;
const freshScope = (): Scope => ({
  caller: { userId: UUID(99), groupId: null },
  accounts: [CHECKING, SAVINGS],
  categories: [FOOD],
  labels: [TRIP],
  goals: [],
  existingRefs: {
    budgets: new Set(),
    goals: new Set(),
    goalContributions: new Set(),
    debts: new Set(),
    statements: new Set(),
    accounts: new Set(["acc-1", "acc-2"]),
    members: new Set(),
    categories: new Set(["cat-1"]),
    labels: new Set(["lab-1"]),
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

// ---- M3: an account's opening off a backup, and the cap on a second amount (RF-142, RF-51, RF-126) --

const ACCOUNT_COLUMNS = ["externalRef", "name", "kind", "subtype", "placement", "institution", "amount", "balanceOn", "settlementCurrency"] as const;

async function bookAccounts(rows: Record<string, string | number | null>[]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(messages.data.sheets.accounts);
  sheet.addRow(ACCOUNT_COLUMNS.map((key) => messages.data.columns[key]));
  for (const row of rows) sheet.addRow(ACCOUNT_COLUMNS.map((key) => row[key] ?? null));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

async function runAccounts(bytes: Uint8Array) {
  const { runImportPipeline } = await import("./import-pipeline");
  const result = await runImportPipeline({ buffer: buffer(bytes) });
  return result.perEntity.find((e) => e.entity === "accounts")!.rows;
}

const cardRow = (amount: string | number, over: Record<string, string | number | null> = {}) => ({
  externalRef: "card-m3",
  name: "Tarjeta M3",
  kind: "liability",
  subtype: "card",
  placement: "personal",
  amount,
  balanceOn: "2026-01-01",
  settlementCurrency: "COP",
  ...over,
});

test("RF-142: a card the backup wrote at -150000 (a number cell, as the export writes it) passes the import with no error", async () => {
  const rows = await runAccounts(await bookAccounts([cardRow(-150000)]));
  assert.deepEqual(rows.map((r) => r.errors), [[]]);
  assert.notEqual(rows[0].object, null);
});

test("RF-142: a card typed at -150000,00 and one typed at 150000,00 both pass the import with no error", async () => {
  const rows = await runAccounts(
    await bookAccounts([cardRow("-150000,00"), cardRow("150000,00", { externalRef: "card-m3-b", name: "Tarjeta M3 b" })]),
  );
  assert.deepEqual(rows.map((r) => r.errors), [[], []]);
});

test("RF-51: an asset row opened at -100 is refused as accounts.errors.amountInvalid on its amount, and carries no object", async () => {
  const rows = await runAccounts(
    await bookAccounts([cardRow("-100", { externalRef: "bank-m3", name: "Banco M3", kind: "asset", subtype: "bank" })]),
  );
  assert.equal(rows[0].object, null);
  assert.deepEqual(rows[0].errors.map((e) => [e.key, e.column]), [["accounts.errors.amountInvalid", "amount"]]);
});

// The cap a second amount is held to is the one its account's currency stores (RF-126): the card settles in pesos.
// Every currency shares one cap in the stored scale, so the row guard refuses these before the pipeline's own
// check runs: U4 and U5 on that check are equivalent while the caps stay equal.
const CAP = maxAmountMinor("COP");
const written = (minor: number) => `${Math.trunc(minor / 100)},${String(minor % 100).padStart(2, "0")}`;

test("RF-51: a second amount of exactly the cap passes, read to the cap's own integer", async () => {
  const rows = await run(await bookForeign([dollarPurchase({ counterAmount: written(CAP) })]));
  assert.deepEqual(rows[0].errors, []);
  const object = rows[0].object as Parsed;
  assert.equal(centsOf(object.counterAmountCents, object.counterAmount), CAP);
});

test("RF-51: a second amount one stored unit over the cap is refused on that row, amountTooLarge on counterAmount", async () => {
  const rows = await run(await bookForeign([dollarPurchase({ counterAmount: written(CAP + 1) })]));
  assert.equal(rows[0].object, null);
  assert.deepEqual(rows[0].errors.map((e) => [e.key, e.column]), [["transactions.errors.amountTooLarge", "counterAmount"]]);
});

test("RF-51: a second amount far over the cap is refused on that row alone, amountTooLarge on counterAmount", async () => {
  const rows = await run(
    await bookForeign([dollarPurchase({ counterAmount: written(CAP * 100), externalRef: "far" }), dollarPurchase({ externalRef: "fine" })]),
  );
  assert.equal(rows[0].object, null);
  assert.deepEqual(rows[0].errors.map((e) => [e.key, e.column]), [["transactions.errors.amountTooLarge", "counterAmount"]]);
  assert.deepEqual(rows[1].errors, []);
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

// ---- O6-M7: a row dated before the opening of an account it names (RF-162) ---------------------------

const BEFORE_OPENING = "data.import.errors.beforeOpening";

async function bookBoth(accountRows: Record<string, string | number | null>[], transactions: Cells[]) {
  const wb = new ExcelJS.Workbook();
  const accountSheet = wb.addWorksheet(messages.data.sheets.accounts);
  accountSheet.addRow(ACCOUNT_COLUMNS.map((key) => messages.data.columns[key]));
  for (const row of accountRows) accountSheet.addRow(ACCOUNT_COLUMNS.map((key) => row[key] ?? null));
  const movementSheet = wb.addWorksheet(messages.data.sheets.transactions);
  movementSheet.addRow(COLUMNS.map((key) => messages.data.columns[key]));
  for (const row of transactions) movementSheet.addRow(COLUMNS.map((key) => row[key] ?? null));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

async function runAll(bytes: Uint8Array) {
  const { runImportPipeline } = await import("./import-pipeline");
  return runImportPipeline({ buffer: buffer(bytes) });
}

const on = (day: string, over: Cells = {}): Cells => ({ ...spend(1000, `on ${day}`), occurredAt: day, ...over });
const wordsOf = (row: { errors: { key: string; column: string | null }[] }) => row.errors.map((e) => [e.key, e.column]);

test("RF-162: a row dated the day before an existing account's opening is refused on occurredAt, with no object", async () => {
  const rows = await run(await book([on("2025-12-31")]));
  assert.deepEqual(wordsOf(rows[0]), [[BEFORE_OPENING, "occurredAt"]]);
  assert.equal(rows[0].object, null);
});

test("RF-162: a row dated the opening day itself is clean", async () => {
  const rows = await run(await book([on("2026-01-01")]));
  assert.deepEqual(rows[0].errors, []);
  assert.notEqual(rows[0].object, null);
});

test("RF-162: the day after the opening is clean too, so the line is the opening and not a week around it", async () => {
  const rows = await run(await book([on("2026-01-02"), on("2026-06-30")]));
  assert.deepEqual(rows.map((r) => r.errors), [[], []]);
});

test("RF-162: the refused row is counted in the totals, and its clean neighbour is counted as new", async () => {
  const result = await runAll(await book([on("2025-12-31"), on("2026-01-05")]));
  assert.deepEqual(result.totals, { new: 1, update: 0, error: 1 });
});

test("RF-162: the destination leg is held to its account's opening as well", async () => {
  scope.categories = [FOOD, { ...FOOD, id: UUID(12), name: "Pay", externalRef: "cat-2", kind: "income" }];
  const rows = await run(
    await book([{ toAccount: "Checking", amount: 5000, occurredAt: "2025-12-31", description: "income", category: "Pay" }]),
  );
  assert.deepEqual(wordsOf(rows[0]), [[BEFORE_OPENING, "occurredAt"]]);
});

test("RF-162: a transfer is refused when only its second account opens later than the day", async () => {
  scope.accounts = [CHECKING, { ...SAVINGS, initialBalanceOn: "2026-03-01" }];
  const rows = await run(
    await book([{ fromAccount: "Checking", toAccount: "Savings", amount: 5000, occurredAt: "2026-02-01", description: "move" }]),
  );
  assert.deepEqual(wordsOf(rows[0]), [[BEFORE_OPENING, "occurredAt"]]);
});

test("RF-162: each account is held to its own opening, not to the earliest or the latest of the file", async () => {
  scope.accounts = [CHECKING, { ...SAVINGS, initialBalanceOn: "2026-03-01" }];
  const rows = await run(
    await book([
      on("2026-02-01"),
      { fromAccount: "Savings", amount: 100, category: "Food", occurredAt: "2026-02-01", description: "savings early" },
      { fromAccount: "Savings", amount: 100, category: "Food", occurredAt: "2026-03-01", description: "savings on the day" },
    ]),
  );
  assert.deepEqual(rows.map((r) => r.errors.length), [0, 1, 0]);
});

test("RF-162: a row that names an account nobody has reports the unknown reference and no opening error", async () => {
  const rows = await run(await book([on("2025-12-31", { fromAccount: "Nadie" })]));
  assert.ok(rows[0].errors.length > 0);
  assert.ok(rows[0].errors.every((e) => e.key !== BEFORE_OPENING));
});

test("RF-162: an adjustment row dated before its account's opening is refused the same way", async () => {
  const rows = await run(
    await book([{ fromAccount: "Checking", amount: 500, occurredAt: "2025-12-31", description: "adjust", adjustment: true as never }]),
  );
  assert.ok(rows[0].errors.some((e) => e.key === BEFORE_OPENING && e.column === "occurredAt"), JSON.stringify(rows[0].errors));
});

const newBank = (balanceOn: string, over: Record<string, string | number | null> = {}) => ({
  externalRef: "bank-new",
  name: "Banco nuevo",
  kind: "asset",
  subtype: "bank",
  placement: "personal",
  amount: 1000,
  balanceOn,
  settlementCurrency: "COP",
  ...over,
});

test("RF-162: a movement earlier than the opening of an account created in the same file is refused on occurredAt", async () => {
  const result = await runAll(
    await bookBoth([newBank("2026-02-01")], [on("2026-01-15", { fromAccount: "Banco nuevo" })]),
  );
  const accountRows = result.perEntity.find((e) => e.entity === "accounts")!.rows;
  const movementRows = result.perEntity.find((e) => e.entity === "transactions")!.rows;
  assert.deepEqual(accountRows.map((r) => r.errors), [[]]);
  assert.deepEqual(wordsOf(movementRows[0]), [[BEFORE_OPENING, "occurredAt"]]);
  assert.equal(result.totals.error, 1);
});

test("RF-162: a movement on the opening day of an account created in the same file is clean", async () => {
  const result = await runAll(
    await bookBoth([newBank("2026-02-01")], [on("2026-02-01", { fromAccount: "Banco nuevo" })]),
  );
  assert.deepEqual(result.totals, { new: 2, update: 0, error: 0 });
});

test("RF-162: the file-new account is held to its own row's day, not to a same-named stored account's", async () => {
  // The file-new account opens in January; the stored Checking opens 2026-01-01. A movement on 2026-01-10 on the
  // new one passes only if its own opening (2025-12-01) is what counts, and one dated 2025-11-30 fails.
  const result = await runAll(
    await bookBoth(
      [newBank("2025-12-01")],
      [on("2025-12-15", { fromAccount: "Banco nuevo" }), on("2025-11-30", { fromAccount: "Banco nuevo", description: "early" })],
    ),
  );
  const movementRows = result.perEntity.find((e) => e.entity === "transactions")!.rows;
  assert.deepEqual(movementRows.map((r) => r.errors.length), [0, 1]);
});

// ---- labels (RF-142, RF-70) -------------------------------------------------------------------

const LABEL_COLUMNS = [...COLUMNS, "labels"] as const;

async function bookLabels(labelRows: Record<string, string | null>[], movements: Record<string, string | number | null | undefined>[]) {
  const wb = new ExcelJS.Workbook();
  const labels = wb.addWorksheet(messages.data.sheets.labels);
  const labelKeys = ["externalRef", "name", "color"];
  labels.addRow(labelKeys.map((key) => messages.data.columns[key]));
  for (const row of labelRows) labels.addRow(labelKeys.map((key) => row[key] ?? null));
  const sheet = wb.addWorksheet(messages.data.sheets.transactions);
  sheet.addRow(LABEL_COLUMNS.map((key) => messages.data.columns[key]));
  for (const row of movements) sheet.addRow(LABEL_COLUMNS.map((key) => row[key] ?? null));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

async function sheetsOf(bytes: Uint8Array) {
  const result = await runAll(bytes);
  return (entity: string) => result.perEntity.find((e) => e.entity === entity)!.rows;
}

test("a movement names its labels in one cell: an existing one by its id, a file-new one by its placeholder", async () => {
  const rows = await sheetsOf(
    await bookLabels(
      [{ name: "Gift", color: "#06B6D4" }],
      [{ ...spend(1000, "labelled"), labels: "Gift; Trip" }],
    ),
  );
  const [label] = rows("labels");
  assert.deepEqual(label.errors, []);
  assert.equal(label.status, "new");
  assert.ok(label.placeholderId);
  const [movement] = rows("transactions");
  assert.deepEqual(movement.errors, []);
  assert.deepEqual((movement.object as { labelIds: string[] }).labelIds, [label.placeholderId, TRIP.id]);
});

test("a label name nobody holds refuses its movement on the labels cell", async () => {
  const rows = await sheetsOf(await bookLabels([], [{ ...spend(1000, "a"), labels: "Trip; Nowhere" }]));
  const [movement] = rows("transactions");
  assert.deepEqual(movement.errors, [{ key: "data.import.errors.unknownReference", column: "labels", value: "Trip; Nowhere" }]);
});

test("a blank labels cell is no labels, and an existing label's key updates it", async () => {
  const rows = await sheetsOf(
    await bookLabels([{ externalRef: "lab-1", name: "Trip renamed", color: "#DC2626" }], [{ ...spend(1000, "a"), labels: "Trip renamed" }, spend(2000, "b")]),
  );
  assert.equal(rows("labels")[0].status, "update");
  const [labelled, bare] = rows("transactions");
  assert.deepEqual((labelled.object as { labelIds: string[] }).labelIds, [TRIP.id]);
  assert.deepEqual((bare.object as { labelIds: string[] }).labelIds, []);
});

test("a label row with no colour is refused, as the form refuses it", async () => {
  const rows = await sheetsOf(await bookLabels([{ name: "Gift", color: null }], []));
  assert.equal(rows("labels")[0].errors[0]?.column, "color");
});

// ---- budgets, goals and their contributions (RF-142) ------------------------------------------

type SheetRows = Record<string, Record<string, string | number | boolean | null>[]>;

async function bookSheets(sheets: SheetRows) {
  const { sheetDescriptors } = await import("./schema");
  const wb = new ExcelJS.Workbook();
  for (const [entity, rows] of Object.entries(sheets)) {
    const sheet = wb.addWorksheet(messages.data.sheets[entity]);
    const keys = (sheetDescriptors[entity as keyof typeof sheetDescriptors].columns as readonly { key: string }[]).map((c) => c.key);
    sheet.addRow(keys.map((key) => messages.data.columns[key]));
    for (const row of rows) sheet.addRow(keys.map((key) => row[key] ?? null));
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const FUND = UUID(500);
const FUND_FOOD = { ...FOOD, id: UUID(13), externalRef: "cat-fund", ownerUserId: null, groupId: FUND };

test("a budget's category is the one held in the place its row names, personal or fund", async () => {
  scope.caller.groupId = FUND;
  scope.categories = [FOOD, FUND_FOOD];
  const rows = await sheetsOf(
    await bookSheets({
      budgets: [
        { placement: "personal", category: "Food", period: "monthly", limit: 500000, thresholdPct: 80 },
        { placement: "group", category: "Food", account: "Checking", period: "monthly", limit: 500000, thresholdPct: 80, archived: true },
      ],
    }),
  );
  const [own, fund] = rows("budgets");
  assert.deepEqual(own.errors, []);
  assert.equal((own.object as { categoryId: string }).categoryId, FOOD.id);
  assert.equal((own.object as { archived: boolean }).archived, false);
  // Checking is the caller's own, never the fund's: the place refuses it.
  assert.deepEqual(fund.errors, [{ key: "data.import.errors.outOfPlace", column: "account", value: "Checking" }]);
});

test("a row placed in the fund, from someone with no fund, is refused on its placement", async () => {
  const rows = await sheetsOf(await bookSheets({ goals: [{ name: "Viaje", placement: "group", targetAmount: 1000000 }] }));
  assert.deepEqual(rows("goals")[0].errors, [{ key: "data.import.errors.noFund", column: "placement", value: "group" }]);
});

test("a contribution names a file-new goal by name and a movement by its key; an unknown key is refused", async () => {
  scope.existingRefs.transactions = new Set(["mov-1"]);
  const rows = await sheetsOf(
    await bookSheets({
      goals: [{ name: "Viaje", placement: "personal", targetAmount: 1000000, targetDate: "2027-06-01" }],
      goalContributions: [
        { goal: "Viaje", amount: 50000, contributedOn: "2026-10-01", movement: "mov-1" },
        { goal: "Viaje", amount: 20000, contributedOn: "2026-10-02" },
        { goal: "Viaje", amount: 20000, contributedOn: "2026-10-03", movement: "nowhere" },
      ],
    }),
  );
  const [goal] = rows("goals");
  assert.deepEqual(goal.errors, []);
  const [linked, bare, lost] = rows("goalContributions");
  assert.deepEqual(linked.errors, []);
  assert.deepEqual(linked.object, { goalId: goal.placeholderId, amount: "50000", contributedOn: "2026-10-01", movement: "mov-1" });
  assert.equal((bare.object as { movement: string | null }).movement, null);
  assert.deepEqual(lost.errors, [{ key: "data.import.errors.unknownReference", column: "movement", value: "nowhere" }]);
});

// ---- debts and statements (RF-142, RF-78, RF-129) ---------------------------------------------

test("a rate the ledger keeps as a fraction reads as the percentage a person types", async () => {
  const { fractionToPercent } = await import("@/lib/validation/debt-terms");
  const cases: [string, string][] = [["0.2899", "28.99"], ["0.289900", "28.99"], ["0", "0"], ["0.05", "5"], ["1", "100"], ["0.123456", "12.3456"], ["0.0005", "0.05"]];
  for (const [fraction, percent] of cases) assert.equal(fractionToPercent(fraction), percent, fraction);
});

test("a debt row is new for an account with no terms and an update for one that has them; blank figures are none", async () => {
  scope.existingRefs.debts = new Set([SAVINGS.id]);
  const rows = await sheetsOf(
    await bookSheets({
      debts: [
        { account: "Checking", debtKind: "revolving", annualRate: "28.99", minimumPaymentPct: "5", cutOffDay: 15, dueDay: 30 },
        { account: "Savings", debtKind: "installment", annualRate: 12, minimumPayment: 350000 },
      ],
    }),
  );
  const [fresh, known] = rows("debts");
  assert.deepEqual(fresh.errors, []);
  assert.equal(fresh.status, "new");
  assert.deepEqual(fresh.object, {
    accountId: CHECKING.id,
    debtKind: "revolving",
    annualRate: "28.99",
    minimumPayment: null,
    minimumPaymentPct: "5",
    creditLimit: null,
    statementCutOffDay: 15,
    paymentDueDay: 30,
    aval: null,
  });
  assert.equal(known.status, "update");
  assert.equal((known.object as { minimumPayment: string }).minimumPayment, "350000");
});

test("a statement keeps its signed figures; one already closed for that cut-off is an update, a cut-off before its start is refused", async () => {
  scope.existingRefs.statements = new Set([`${CHECKING.id}|2026-09-15`]);
  const rows = await sheetsOf(
    await bookSheets({
      statements: [
        { account: "Checking", periodStart: "2026-08-16", cutOffDate: "2026-09-15", closingBalance: -1250000.5 },
        { account: "Checking", periodStart: "2026-09-16", cutOffDate: "2026-10-15", paymentDueDate: "2026-10-30", closingBalance: -980000, interestCharged: 31250 },
        { account: "Checking", periodStart: "2026-11-16", cutOffDate: "2026-11-15", closingBalance: 0 },
      ],
    }),
  );
  const [closed, fresh, backwards] = rows("statements");
  assert.equal(closed.status, "update");
  assert.equal((closed.object as { closingBalance: string }).closingBalance, "-1250000.5");
  assert.equal(fresh.status, "new");
  assert.deepEqual(fresh.errors, []);
  assert.equal((fresh.object as { interestCharged: string; openingBalance: null }).interestCharged, "31250");
  assert.equal((fresh.object as { openingBalance: null }).openingBalance, null);
  assert.equal(backwards.errors[0]?.column, "periodStart");
});

// ---- review: scopes, repeats (RF-142) ---------------------------------------------------------

test("a label keeps the place its row names; blank lands in the caller's fund, and a fund label on a personal movement is refused", async () => {
  scope.caller.groupId = UUID(500);
  const rows = await sheetsOf(
    await bookSheets({
      labels: [
        { name: "Own", placement: "personal", color: "#06B6D4" },
        { name: "Shared", color: "#06B6D4" },
      ],
      transactions: [
        { ...spend(1000, "own"), labels: "Own; Own" },
        { ...spend(2000, "shared"), labels: "Shared" },
      ],
    }),
  );
  const [own, shared] = rows("labels");
  assert.equal((own.object as { placement: string }).placement, "personal");
  assert.equal((shared.object as { placement: string }).placement, "group");
  const [owned, refused] = rows("transactions");
  assert.deepEqual((owned.object as { labelIds: string[] }).labelIds, [own.placeholderId]);
  assert.deepEqual(refused.errors, [{ key: "data.import.errors.outOfPlace", column: "labels", value: "Shared" }]);
});

test("a second row for one account's terms, or one account's cut-off, is refused; the first stands", async () => {
  const rows = await sheetsOf(
    await bookSheets({
      debts: [
        { account: "Checking", debtKind: "revolving", annualRate: "20" },
        { account: "Checking", debtKind: "revolving", annualRate: "21" },
      ],
      statements: [
        { account: "Checking", periodStart: "2026-08-16", cutOffDate: "2026-09-15", closingBalance: -100 },
        { account: "Checking", periodStart: "2026-08-17", cutOffDate: "2026-09-15", closingBalance: -200 },
      ],
    }),
  );
  for (const entity of ["debts", "statements"]) {
    const [first, second] = rows(entity);
    assert.deepEqual(first.errors, [], entity);
    assert.deepEqual(second.errors, [{ key: "data.import.errors.repeatedRow", column: "account", value: null }], entity);
    assert.equal(second.object, null, entity);
  }
});
