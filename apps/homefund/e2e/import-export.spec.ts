/**
 * The spreadsheet round trip, driven in a browser and read back from Postgres:
 * the template (RF-49), an import with its preview (RF-51), the same file again
 * (RF-52), a file with a malformed row (RF-51: all or nothing) and the filtered
 * export (RF-118).
 *
 * The workbooks are built here from the columns `lib/spreadsheet/schema.ts`
 * declares and the headers `messages/es.json` gives them, with the amounts a
 * person types in Excel: pesos with decimals. The cents each one must become are
 * worked out here, by hand: 1 234,56 is 123456 and 0,07 is 7 (a float
 * multiplication would store 7.000000000000001).
 *
 * The database facts run on the laptop; the screen is the same at every width.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

import { todayInBogota } from "@/lib/dates";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import {
  SHEET_ENTITIES,
  sheetDescriptors,
  transactionSheetDescriptor,
  type SheetEntity,
} from "@/lib/spreadsheet/schema";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearGroup, clearLedger, readScope, seedGroup, test } from "./global-setup";

const data = messages.data;
const stamp = randomUUID().slice(0, 8);
const scope = readScope();

const ACCOUNT_NAME = `E9 Cuenta hoja ${stamp}`;
const OTHER_ACCOUNT_NAME = `E9 Cuenta otra ${stamp}`;
const CATEGORY_NAME = `E9 Categoría hoja ${stamp}`;

const ids = {
  account: randomUUID(),
  otherAccount: randomUUID(),
  category: randomUUID(),
};

const dir = mkdtempSync(join(tmpdir(), "e9-import-"));

test.skip(({ viewport }) => viewport?.width === 360, "the database facts are read once, on the laptop");

test.beforeAll(async () => {
  // A group the lane left behind would move the import into its scope.
  await clearGroup();
  await asHarnessUser(async (tx) => {
    for (const [id, name] of [
      [ids.account, ACCOUNT_NAME],
      [ids.otherAccount, OTHER_ACCOUNT_NAME],
    ] as const) {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${id}, ${scope.userId}, ${name}, 'asset', 'bank', 0, '2026-01-01')`;
    }
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${ids.category}, ${scope.userId}, ${CATEGORY_NAME}, 'expense', '#4C8C4A')`;
  });
});

test.afterAll(async () => {
  await clearLedger();
  await fixtureSql`delete from accounts where id in ${fixtureSql([ids.account, ids.otherAccount])}`;
  await fixtureSql`delete from categories where id = ${ids.category}`;
});

test.beforeEach(async () => {
  await clearLedger();
});

test.afterEach(async () => {
  await clearLedger();
});

type SheetRow = {
  externalRef: string;
  fromAccount: string | null;
  toAccount?: string | null;
  amount: number | string;
  category: string | null;
  occurredAt: string;
  description?: string | null;
  currency?: string | null;
  counterAmount?: number | null;
  counterIsEstimate?: boolean | null;
};

// A transactions sheet with the header the descriptor's columns carry in Spanish.
// Each row is read back by the descriptor's own keys, so the file is shaped by the
// contract and not by a copy of what the importer happens to read.
async function workbookFile(name: string, rows: SheetRow[]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(data.sheets.transactions);
  const keys = transactionSheetDescriptor.columns.map((column) => column.key);
  sheet.addRow(keys.map((key) => data.columns[key as keyof typeof data.columns]));
  for (const row of rows) {
    sheet.addRow(keys.map((key) => (row as Record<string, unknown>)[key] ?? null));
  }
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(await workbook.xlsx.writeBuffer()));
  return path;
}

function validRows(): SheetRow[] {
  return [
    {
      externalRef: `e9-${stamp}-grande`,
      fromAccount: ACCOUNT_NAME,
      amount: 1234.56,
      category: CATEGORY_NAME,
      occurredAt: "2026-03-31",
      description: "E9 grande",
    },
    {
      externalRef: `e9-${stamp}-chico`,
      fromAccount: ACCOUNT_NAME,
      amount: 0.07,
      category: CATEGORY_NAME,
      occurredAt: "2026-03-31",
      description: "E9 chico",
    },
  ];
}

const totalsBadge = (page: Page, text: string) => page.getByText(text, { exact: true });

async function chooseFile(page: Page, path: string) {
  await page.goto("/es/settings/data");
  await page.locator('input[type="file"]').setInputFiles(path);
}

async function importedRows() {
  return fixtureSql<
    { id: string; external_ref: string; amount_cents: string; occurred_at: string; kind: string }[]
  >`
    select id, external_ref, amount_cents::text as amount_cents, occurred_at::text as occurred_at, kind
    from transactions
    where owner_user_id = ${scope.userId} and external_ref like ${`e9-${stamp}-%`}
    order by external_ref`;
}

test.describe("import", () => {
  test("a valid file previews two new rows, and confirming stores 123456 and 7 cents dated 2026-03-31", async ({
    page,
  }) => {
    // Kills: the pesos read as a float times a hundred, which stores 7.000000000000001.
    await chooseFile(page, await workbookFile("valid.xlsx", validRows()));

    await expect(totalsBadge(page, "2 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "0 actualizadas")).toBeVisible();
    await expect(totalsBadge(page, "0 con errores")).toBeVisible();
    await expect(page.getByText(data.screen.importReady, { exact: true })).toBeVisible();
    // The preview writes nothing.
    expect(await importedRows()).toEqual([]);

    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();
    await expect(page.getByText(data.screen.importDone, { exact: true })).toBeVisible();

    const rows = await importedRows();
    expect(rows.map((row) => [row.external_ref, row.amount_cents, row.occurred_at, row.kind])).toEqual([
      [`e9-${stamp}-chico`, "7", "2026-03-31", "expense"],
      [`e9-${stamp}-grande`, "123456", "2026-03-31", "expense"],
    ]);

    // One split per movement, for the whole amount (RF-69).
    for (const row of rows) {
      const splits = await fixtureSql<{ category_id: string; amount_cents: string }[]>`
        select category_id, amount_cents::text as amount_cents
        from transaction_splits where transaction_id = ${row.id}`;
      expect(splits).toEqual([{ category_id: ids.category, amount_cents: row.amount_cents }]);
    }
  });

  test("the same file imported twice is two updates the second time and adds no row", async ({ page }) => {
    // Kills: the stable reference ignored, so every row is new again.
    const path = await workbookFile("again.xlsx", validRows());

    await chooseFile(page, path);
    await expect(totalsBadge(page, "2 nuevas")).toBeVisible();
    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();
    await expect(page.getByText(data.screen.importDone, { exact: true })).toBeVisible();
    const first = await importedRows();
    expect(first).toHaveLength(2);

    await page.locator('input[type="file"]').setInputFiles(path);
    await expect(totalsBadge(page, "0 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "2 actualizadas")).toBeVisible();
    // The first toast may still be on screen, so the second commit is awaited by its response.
    const committed = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/es/settings/data"),
    );
    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();
    await committed;

    const second = await importedRows();
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(second.map((row) => row.amount_cents)).toEqual(["7", "123456"]);
  });

  test("a malformed amount is reported on its own row, confirming is off, and not even the valid row is written", async ({
    page,
  }) => {
    // Kills: the confirm button live over a file with errors, so a partial file could be sent.
    const rows = validRows();
    rows[1].amount = "12abc";
    await chooseFile(page, await workbookFile("broken.xlsx", rows));

    await expect(totalsBadge(page, "1 nueva")).toBeVisible();
    await expect(totalsBadge(page, "1 con error")).toBeVisible();

    // The report names the sheet, the row as Excel numbers it (header is 1) and the problem.
    const report = page.getByRole("table", { name: data.screen.importHeading });
    const reportRow = report.getByRole("row").filter({ hasText: messages.transactions.errors.amountInvalid });
    await expect(reportRow).toHaveCount(1);
    await expect(reportRow).toContainText(data.sheets.transactions);
    await expect(reportRow).toContainText("3");

    await expect(page.getByRole("button", { name: data.screen.confirmImport, exact: true })).toBeDisabled();
    expect(await importedRows()).toEqual([]);
  });

  test("the server re-checks the file: a broken file sent as the commit is refused whole, with nothing written", async ({
    page,
  }) => {
    // Kills: the commit trusting the preview, so errored rows travel to the write.
    const good = await workbookFile("swap-good.xlsx", validRows());
    const brokenRows = validRows();
    brokenRows[1].amount = "12abc";
    const broken = readFileSync(await workbookFile("swap-broken.xlsx", brokenRows));

    await chooseFile(page, good);
    await expect(totalsBadge(page, "2 nuevas")).toBeVisible();

    // Swaps the file's bytes inside the commit's multipart body for the broken file's.
    await page.route(
      (url) => url.pathname === "/es/settings/data",
      async (route) => {
        const request = route.request();
        const body = request.postDataBuffer();
        const type = request.headers()["content-type"] ?? "";
        if (request.method() !== "POST" || !body || !type.includes("multipart/form-data")) {
          await route.continue();
          return;
        }
        // Playwright hands over a file part without its bytes, so the part is
        // rebuilt around the broken file: its headers end at the first blank line.
        const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), body.indexOf(Buffer.from("_1_file")));
        const partEnd = body.indexOf(Buffer.from(`\r\n--${type.split("boundary=")[1]}`), headersEnd + 4);
        expect(headersEnd).toBeGreaterThan(0);
        expect(partEnd).toBeGreaterThanOrEqual(headersEnd + 4);
        await route.continue({
          postData: Buffer.concat([body.subarray(0, headersEnd + 4), broken, body.subarray(partEnd)]),
        });
      },
    );

    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();

    await expect(page.getByText(data.import.errors.hasErrors, { exact: true })).toBeVisible();
    expect(await importedRows()).toEqual([]);
  });
});

async function downloaded(page: Page, path: string): Promise<ExcelJS.Workbook> {
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("spreadsheetml.sheet");
  const workbook = new ExcelJS.Workbook();
  const body = await response.body();
  // ExcelJS types its input as its own Buffer, which is an ArrayBuffer at runtime.
  await workbook.xlsx.load(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ExcelJS.Buffer);
  return workbook;
}

test.describe("export and template", () => {
  async function seedMovement(accountId: string, cents: number, description: string) {
    await asHarnessUser(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into transactions (from_account_id, amount_cents, occurred_at, description)
        values (${accountId}, ${cents}, '2026-03-31', ${description})
        returning id`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${row.id}, ${ids.category}, ${cents})`;
    });
  }

  test("exporting one account carries exactly the movements the list shows for it, amounts 1234.56 and 0.07", async ({
    page,
  }) => {
    // Kills: the account filter dropped from the export query, so the other account's rows come out too.
    await seedMovement(ids.account, 123_456, "E9 uno");
    await seedMovement(ids.account, 7, "E9 dos");
    await seedMovement(ids.otherAccount, 500_000, "E9 ajeno");

    const workbook = await downloaded(
      page,
      `/es/settings/data/export?entities=transactions&account=${ids.account}`,
    );
    const sheet = workbook.getWorksheet(data.sheets.transactions)!;
    const header = (sheet.getRow(1).values as string[]).slice(1);
    const column = (key: string) => header.indexOf(data.columns[key as keyof typeof data.columns]) + 1;

    const exported: { from: string; amount: number; description: string }[] = [];
    for (let row = 2; row <= sheet.rowCount; row += 1) {
      exported.push({
        from: String(sheet.getRow(row).getCell(column("fromAccount")).value),
        amount: Number(sheet.getRow(row).getCell(column("amount")).value),
        description: String(sheet.getRow(row).getCell(column("description")).value),
      });
    }
    exported.sort((a, b) => a.amount - b.amount);
    expect(exported).toEqual([
      { from: ACCOUNT_NAME, amount: 0.07, description: "E9 dos" },
      { from: ACCOUNT_NAME, amount: 1234.56, description: "E9 uno" },
    ]);

    // The same filter on the list: the same two rows.
    await page.goto(`/es/movements?account=${ids.account}&from=2026-03-31&to=2026-03-31`);
    const ledger = page.getByRole("table", { name: messages.transactions.listTitle });
    await expect(ledger.getByText("E9 uno", { exact: true })).toBeVisible();
    await expect(ledger.getByText("E9 dos", { exact: true })).toBeVisible();
    await expect(ledger.getByText("E9 ajeno", { exact: true })).toHaveCount(0);
  });

  test("the template carries the five sheets in the import's shape and offers the caller's account and category as options", async ({
    page,
  }) => {
    // Kills: the options sheet written empty, so the dropdowns offer nothing (RF-49).
    const workbook = await downloaded(page, "/es/settings/data/template");

    for (const entity of SHEET_ENTITIES) {
      const sheet = workbook.getWorksheet(data.sheets[entity]);
      expect(sheet, data.sheets[entity]).toBeDefined();
      const header = (sheet!.getRow(1).values as string[]).slice(1);
      expect(header).toEqual(
        sheetDescriptors[entity].columns.map((column) => data.columns[column.key as keyof typeof data.columns]),
      );
      // A template holds no data row.
      expect(sheet!.actualRowCount).toBe(1);
    }

    const options = workbook.getWorksheet("options")!;
    expect(options.state).toBe("hidden");
    const accountOptions: string[] = [];
    const categoryOptions: string[] = [];
    options.eachRow((row) => {
      const [, accountName, categoryName] = row.values as (string | undefined)[];
      if (accountName) accountOptions.push(accountName);
      if (categoryName) categoryOptions.push(categoryName);
    });
    expect(accountOptions).toContain(ACCOUNT_NAME);
    expect(accountOptions).toContain(OTHER_ACCOUNT_NAME);
    expect(categoryOptions).toContain(CATEGORY_NAME);

    // The account column of the movements sheet is a dropdown over exactly that list.
    const movements = workbook.getWorksheet(data.sheets.transactions)!;
    const fromColumn = transactionSheetDescriptor.columns.findIndex((column) => column.key === "fromAccount") + 1;
    expect(movements.getCell(2, fromColumn).dataValidation).toMatchObject({
      type: "list",
      formulae: [`options!$A$1:$A$${accountOptions.length}`],
    });
  });
});

// RF-140 (importer half): a person in a fund holds the same category name twice, personal and
// fund. The row's account decides which one it books; a name only the other scope holds is
// refused on its own row at preview, and nothing is written (RF-51).
test.describe("import resolves a category by its account's scope", () => {
  const m28 = `m28-${stamp}`;
  const MERCADO = `T3 Mercado ${stamp}`;
  const INGRESO = `T3 Ingreso ${stamp}`;
  const SOLO_FONDO = `T3 Solo fondo ${stamp}`;
  const NUEVA = `T3 Nueva ${stamp}`;
  const FUND_ACCOUNT = `T3 Cuenta fondo ${stamp}`;
  const m = {
    fundAccount: randomUUID(),
    mercadoOwn: randomUUID(),
    mercadoFund: randomUUID(),
    ingresoOwn: randomUUID(),
    ingresoFund: randomUUID(),
    soloFondo: randomUUID(),
    nuevaOwn: randomUUID(),
  };
  const refsLike = `${m28}-%`;

  type Sheets = { entity: SheetEntity; rows: Record<string, unknown>[] }[];
  async function multiSheetFile(name: string, sheets: Sheets): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    for (const { entity, rows } of sheets) {
      const sheet = workbook.addWorksheet(data.sheets[entity]);
      const keys = (sheetDescriptors[entity].columns as readonly { key: string }[]).map((column) => column.key);
      sheet.addRow(keys.map((key) => data.columns[key as keyof typeof data.columns]));
      for (const row of rows) sheet.addRow(keys.map((key) => row[key] ?? null));
    }
    const path = join(dir, name);
    writeFileSync(path, Buffer.from(await workbook.xlsx.writeBuffer()));
    return path;
  }

  const expense = (suffix: string, from: string, category: string) => ({
    externalRef: `${m28}-${suffix}`,
    fromAccount: from,
    amount: 15000,
    category,
    occurredAt: "2026-03-31",
    description: `M28 ${suffix}`,
  });

  async function booked() {
    return fixtureSql<{ external_ref: string; category_id: string }[]>`
      select t.external_ref, s.category_id
      from transactions t join transaction_splits s on s.transaction_id = t.id
      where t.external_ref like ${refsLike}
      order by t.external_ref`;
  }
  async function count(table: "transactions" | "recurring_rules"): Promise<number> {
    const [row] = await fixtureSql<{ n: string }[]>`
      select count(*)::text as n from ${fixtureSql(table)} where external_ref like ${refsLike}`;
    return Number(row.n);
  }

  test.beforeAll(async () => {
    const { groupId } = await seedGroup();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${m.fundAccount}, ${groupId}, true, ${FUND_ACCOUNT}, 'asset', 'bank', 0, '2026-01-01')`;
      for (const [id, name, kind, owner] of [
        [m.mercadoOwn, MERCADO, "expense", "own"],
        [m.mercadoFund, MERCADO, "expense", "fund"],
        [m.ingresoOwn, INGRESO, "income", "own"],
        [m.ingresoFund, INGRESO, "income", "fund"],
        [m.soloFondo, SOLO_FONDO, "expense", "fund"],
        // The person already holds the file's new name: only the fund's scope tells the two apart.
        [m.nuevaOwn, NUEVA, "expense", "own"],
      ] as const) {
        await tx`
          insert into categories (id, owner_user_id, group_id, name, kind, color)
          values (${id}, ${owner === "own" ? scope.userId : null}, ${owner === "fund" ? groupId : null},
            ${name}, ${kind}, '#4C8C4A')`;
      }
    });
  });

  test.afterEach(async () => {
    await asHarnessUser(async (tx) => {
      await tx`delete from transactions where external_ref like ${refsLike}`;
      await tx`delete from recurring_rules where external_ref like ${refsLike}`;
    });
  });

  test.afterAll(async () => {
    await asHarnessUser(async (tx) => {
      await tx`delete from transactions where external_ref like ${refsLike}`;
      await tx`delete from recurring_rules where external_ref like ${refsLike}`;
    });
    await fixtureSql`delete from accounts where id = ${m.fundAccount}`;
    await fixtureSql`delete from categories where id in ${fixtureSql(Object.values(m).slice(1))}`;
    await fixtureSql`delete from categories where name = ${NUEVA}`;
    await clearGroup();
  });

  async function confirm(page: Page) {
    const committed = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/es/settings/data"),
    );
    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();
    await committed;
  }

  test("one name in both scopes previews as two new rows, each stored on its own account's category, and again as two updates", async ({
    page,
  }) => {
    // Kills: resolving `category` with the plain name lookup, which calls the pair ambiguous.
    const path = await multiSheetFile("scopes.xlsx", [
      {
        entity: "transactions",
        rows: [expense("own", ACCOUNT_NAME, MERCADO), expense("fund", FUND_ACCOUNT, MERCADO)],
      },
    ]);
    await chooseFile(page, path);
    await expect(totalsBadge(page, "2 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "0 con errores")).toBeVisible();
    expect(await count("transactions")).toBe(0);

    await confirm(page);
    await expect(page.getByText(data.screen.importDone, { exact: true })).toBeVisible();
    expect(await booked()).toEqual([
      { external_ref: `${m28}-fund`, category_id: m.mercadoFund },
      { external_ref: `${m28}-own`, category_id: m.mercadoOwn },
    ]);

    // RF-52: the same file again updates both and adds none.
    await page.locator('input[type="file"]').setInputFiles(path);
    await expect(totalsBadge(page, "0 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "2 actualizadas")).toBeVisible();
    await confirm(page);
    expect(await count("transactions")).toBe(2);
    expect(await booked()).toEqual([
      { external_ref: `${m28}-fund`, category_id: m.mercadoFund },
      { external_ref: `${m28}-own`, category_id: m.mercadoOwn },
    ]);
  });

  test("an income row takes the category of its destination account's scope", async ({ page }) => {
    // Kills: reading the source account for every movement, so an income looks at no scope.
    const income = {
      externalRef: `${m28}-ingreso`,
      toAccount: FUND_ACCOUNT,
      amount: 90000,
      category: INGRESO,
      occurredAt: "2026-03-31",
      description: "M28 ingreso",
    };
    await chooseFile(page, await multiSheetFile("income.xlsx", [{ entity: "transactions", rows: [income] }]));
    await expect(totalsBadge(page, "1 nueva")).toBeVisible();
    await expect(totalsBadge(page, "0 con errores")).toBeVisible();
    await confirm(page);
    await expect(page.getByText(data.screen.importDone, { exact: true })).toBeVisible();
    expect(await booked()).toEqual([{ external_ref: `${m28}-ingreso`, category_id: m.ingresoFund }]);
  });

  test("a personal account naming a category only the fund holds is refused on its row, and the valid row is not written either", async ({
    page,
  }) => {
    // Kills: mapping the out-of-scope outcome to the lone same-named candidate.
    const copy = (data.import.errors as Record<string, string>).categoryOutOfScope;
    expect(copy).toBeTruthy();
    await chooseFile(
      page,
      await multiSheetFile("out-of-scope.xlsx", [
        {
          entity: "transactions",
          rows: [expense("good", ACCOUNT_NAME, MERCADO), expense("bad", ACCOUNT_NAME, SOLO_FONDO)],
        },
      ]),
    );
    await expect(totalsBadge(page, "1 nueva")).toBeVisible();
    await expect(totalsBadge(page, "1 con error")).toBeVisible();
    const report = page.getByRole("table", { name: data.screen.importHeading });
    const reportRow = report.getByRole("row").filter({ hasText: copy });
    await expect(reportRow).toHaveCount(1);
    await expect(reportRow).toContainText(SOLO_FONDO);
    await expect(page.getByRole("button", { name: data.screen.confirmImport, exact: true })).toBeDisabled();
    expect(await count("transactions")).toBe(0);
  });

  test("a recurring rule takes the category of its account's scope", async ({ page }) => {
    // Kills: wiring the scoped resolver into movements only, leaving rules on the plain lookup.
    const rule = (suffix: string, from: string) => ({
      externalRef: `${m28}-${suffix}`,
      fromAccount: from,
      amount: 50000,
      category: MERCADO,
      description: `M28 regla ${suffix}`,
      frequency: "monthly",
      intervalN: 1,
      dayOfMonth: 1,
      nextRunOn: "2026-12-01",
    });
    await chooseFile(
      page,
      await multiSheetFile("rules.xlsx", [
        { entity: "recurringRules", rows: [rule("rown", ACCOUNT_NAME), rule("rfund", FUND_ACCOUNT)] },
      ]),
    );
    await expect(totalsBadge(page, "2 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "0 con errores")).toBeVisible();
    await confirm(page);
    await expect(page.getByText(data.screen.importDone, { exact: true })).toBeVisible();
    const stored = await fixtureSql<{ external_ref: string; category_id: string }[]>`
      select external_ref, category_id from recurring_rules
      where external_ref like ${refsLike} order by external_ref`;
    expect(stored).toEqual([
      { external_ref: `${m28}-rfund`, category_id: m.mercadoFund },
      { external_ref: `${m28}-rown`, category_id: m.mercadoOwn },
    ]);
  });

  test("a category the file adds is the fund's for a person in a fund, so a fund account may name it", async ({
    page,
  }) => {
    // Kills: keying a file-new category as the caller's own while the commit puts it in the fund.
    await chooseFile(
      page,
      await multiSheetFile("new-category.xlsx", [
        {
          entity: "categories",
          rows: [{ name: NUEVA, kind: "expense", color: CATEGORY_COLORS[0] }],
        },
        { entity: "transactions", rows: [expense("nueva", FUND_ACCOUNT, NUEVA)] },
      ]),
    );
    await expect(totalsBadge(page, "2 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "0 con errores")).toBeVisible();
    expect(await count("transactions")).toBe(0);
  });
});

test.describe("a purchase in dollars on a peso account (RF-142, RF-52, RF-123)", () => {
  test("import books it in dollars with the amount charged on the account, and importing the file again leaves it pending its billed amount on Cuentas", async ({
    page,
  }) => {
    // Kills: the import booking the row in pesos, or dropping the estimate mark, so the card shows nothing pending.
    const description = `E9 dólares ${stamp}`;
    const path = await workbookFile("dollars.xlsx", [
      {
        externalRef: `e9-${stamp}-usd`,
        fromAccount: ACCOUNT_NAME,
        amount: 25,
        currency: "USD",
        counterAmount: 105000,
        counterIsEstimate: true,
        category: CATEGORY_NAME,
        occurredAt: todayInBogota(),
        description,
      },
    ]);
    const dollarRow = () =>
      fixtureSql<{ currency: string; amount_cents: string; counter: string | null; estimate: boolean }[]>`
        select currency, amount_cents::text as amount_cents, counter_amount_cents::text as counter,
          counter_is_estimate as estimate
        from transactions
        where owner_user_id = ${scope.userId} and external_ref = ${`e9-${stamp}-usd`}`;

    await chooseFile(page, path);
    await expect(totalsBadge(page, "1 nueva")).toBeVisible();
    await expect(totalsBadge(page, "0 con errores")).toBeVisible();
    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();
    await expect(page.getByText(data.screen.importDone, { exact: true })).toBeVisible();
    expect(await dollarRow()).toEqual([
      { currency: "USD", amount_cents: "2500", counter: "10500000", estimate: true },
    ]);

    await page.locator('input[type="file"]').setInputFiles(path);
    await expect(totalsBadge(page, "0 nuevas")).toBeVisible();
    await expect(totalsBadge(page, "1 actualizada")).toBeVisible();
    const committed = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/es/settings/data"),
    );
    await page.getByRole("button", { name: data.screen.confirmImport, exact: true }).click();
    await committed;
    expect(await dollarRow()).toEqual([
      { currency: "USD", amount_cents: "2500", counter: "10500000", estimate: true },
    ]);

    await page.goto("/es/settings/accounts");
    const settlement = messages.debts.settlement;
    await expect(page.getByText(settlement.title, { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByText(description, { exact: false }).filter({ visible: true })).toHaveCount(1);
    const estimate = page.getByText(settlement.estimate, { exact: true }).filter({ visible: true });
    await expect(estimate).toHaveCount(1);
    expect(Number((await estimate.locator("..").innerText()).replace(/\D/g, ""))).toBe(105000);
    await expect(
      page.getByRole("button", { name: "Confirmar monto", exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
  });
});
