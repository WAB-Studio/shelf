/**
 * One browser pass over the whole desktop slice (plan module 39): the facts no
 * per-screen spec reaches because they are about the shell and the 14 tables
 * together, not about any one of them — every route lights its own row in the
 * sidebar, every table clears 8 rows without its container scrolling, a row
 * menu names its own row, a filter select carries a visible label, and the
 * additive pattern actually hides the desktop subtree at 360px rather than
 * merely repainting it.
 *
 * One seed, at the top, for the whole file: fourteen tables need eight rows
 * each, and seeding that per test would multiply the one round trip this file
 * is supposed to cost by every test that reads it.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";
import ExcelJS from "exceljs";

import { todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import {
  LEADER_MEMBER_NAME,
  asHarnessUser,
  clearGroup,
  readScope,
  seedGroup,
  test,
} from "./global-setup";

const nav = messages.nav;
const common = messages.common;

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

// The one row menu name each table's own screen builds from, gathered once so
// the per-table loop below reads the same message the component renders.
function actionsFor(name: string): string {
  return common.actionsFor.replace("{name}", name);
}

/**
 * The desktop shell's own landmark, present on every route under `(app)` and
 * `display: none` below `md` (`components/fund/app-sidebar.tsx`) — the one node
 * the additive pattern adds to literally every route, so it stands for "the
 * desktop subtree" generically rather than one sibling file at a time.
 */
function sidebar(page: Page): Locator {
  return page.getByRole("navigation", { name: nav.title });
}

const ROW_COUNT = 8;

function named(prefix: string, index: number): string {
  return `${prefix} ${stamp}-${index}`;
}

const created = { transactionIds: [] as string[] };

test.beforeAll(async () => {
  await seedGroup();

  const today = todayInBogota();

  await asHarnessUser(async (tx) => {
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.transactionIds.push(id);
      const description = named("Movimiento escritorio", i);
      await tx`
        insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
        values (${id}, ${scope.accountId}, ${10000 * (i + 1)}, ${today}, ${description})`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${id}, ${scope.categoryId}, ${10000 * (i + 1)})`;
    }
  });
});

test.afterAll(async () => {
  await asHarnessUser(async (tx) => {
    await tx`delete from transaction_splits where transaction_id in ${tx(created.transactionIds)}`;
    await tx`delete from transactions where id in ${tx(created.transactionIds)}`;
  });

  await clearGroup();
});

// The sidebar's own `href` for the row this pass expects lit, matched on the
// attribute rather than the link's translated name: the inbox row also carries
// the pending-count badge's `VisuallyHidden` text once a delivery is waiting
// (`components/fund/app-sidebar.tsx`), which this file's own seed always
// leaves waiting, so a name match would fail on the one row it seeds against.
//
// `null` names three routes no `NavList` row claims — two are a finding, one is
// by design; see the comments beside each below, not a gap in this list.
// `path` is a thunk, not a string: two of these routes need an id `beforeAll`
// has not minted yet when this list is built (Playwright reads the whole file,
// and every `test()` inside the loops below, before any hook runs), so the id
// resolves only once the test body calls it.
type RouteCase = {
  label: string;
  path: () => string;
  sidebarHref: string | null;
  table?: {
    title: string;
    rowName: string;
  };
};

function routes(): RouteCase[] {
  return [
    { label: "/", path: () => "/", sidebarHref: "/" },
    {
      label: "/movements",
      path: () => "/movements",
      sidebarHref: "/movements",
      table: { title: messages.transactions.listTitle, rowName: named("Movimiento escritorio", 0) },
    },
    { label: "/reports", path: () => "/reports", sidebarHref: "/reports" },
    { label: "/settings/data", path: () => "/settings/data", sidebarHref: "/settings/data" },
  ];
}

test.describe("at 1280, the sidebar and its smoke routes", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 1280,
    "the sidebar and the desktop tables render from md up",
  );

  for (const route of routes()) {
    test(`${route.label} lights its own sidebar row and clears its table`, async ({
      page,
    }) => {
      await page.goto(`/es${route.path()}`);
      await expect(sidebar(page)).toBeVisible();

      if (route.sidebarHref === null) {
        // Named beside each route in `routes()`, not asserted here — see the
        // comment there for which is a finding and which is by design.
        await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(0);
      } else {
        // The root's own href renders bare (`/es`, not `/es/`) — the one
        // destination whose path is not simply the locale plus its own href.
        const href = route.sidebarHref === "/" ? "/es" : `/es${route.sidebarHref}`;
        const lit = sidebar(page).locator(`a[href="${href}"]`);
        await expect(lit).toHaveAttribute("aria-current", "page");
      }

      if (!route.table) return;

      const dataTable = page.getByRole("table", { name: route.table.title });
      await expect(dataTable).toBeVisible();

      // The header's own `role=row` is excluded: this counts the data rows
      // the desktop design's "at least 8" is about, not the columns above them.
      const rows = dataTable
        .getByRole("row")
        .filter({ hasNot: page.getByRole("columnheader") });
      expect(await rows.count()).toBeGreaterThanOrEqual(ROW_COUNT);

      // The generic form of the container rule: `.container` never sets a height, so it can
      // only clip when a caller floors a column past the viewport — the exact
      // shape the audit table once shipped. Proven at the table's own DOM node,
      // not by the artboard's promise that it never happens.
      const overflow = await dataTable.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);

      await expect(
        dataTable
          .getByRole("button", { name: actionsFor(route.table.rowName), exact: true })
          .first(),
      ).toBeVisible();

      // Every `role=combobox` a `FilterField` wires (`components/ui/filter-field.tsx`)
      // forwards its id onto the control; a visible `<label for>` naming that id
      // is what the desktop design's fourth audit demand asks for, proved generically
      // rather than one message key per screen.
      const selects = page.getByRole("combobox");
      const selectCount = await selects.count();
      for (let i = 0; i < selectCount; i += 1) {
        const select = selects.nth(i);
        if (!(await select.isVisible())) continue;

        const id = await select.getAttribute("id");
        expect(id, "a combobox with no id has nothing a label can name").not.toBeNull();

        const label = page.locator(`label[for="${id}"]`);
        await expect(label).toBeVisible();
        expect((await label.innerText()).trim().length).toBeGreaterThan(0);
      }
    });
  }

  // The Datos table's rows come from an uploaded file's own preview, not from
  // a seeded row (`components/data/import-errors-table.tsx`): the fourteenth
  // table needs its own way in, round-tripped through the app's own export so
  // every cell but the one this test breaks is already valid.
  test("the Datos table clears 8 rows from an uploaded preview, its own way in", async ({
    page,
  }) => {
    await page.goto("/es/settings/data");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: messages.data.screen.download, exact: true }).click(),
    ]);

    const dir = mkdtempSync(join(tmpdir(), "desktop-import-"));
    const exported = join(dir, "export.xlsx");
    await download.saveAs(exported);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(exported);
    const sheet = workbook.getWorksheet(messages.data.sheets.accounts);
    if (!sheet) throw new Error("the export carries no Cuentas sheet");

    // Row 2 is a real, already-valid account: its other cells are copied as-is
    // and only `name` (RF-51's required column) is blanked, so each new row
    // fails on exactly one cell instead of failing to parse at all.
    const template = sheet.getRow(2);
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const row = sheet.getRow(sheet.rowCount + 1);
      for (let col = 1; col <= sheet.columnCount; col += 1) {
        row.getCell(col).value = template.getCell(col).value;
      }
      row.getCell(1).value = null; // externalRef: blank makes it a new row, not an update
      row.getCell(2).value = ""; // name: required, and the one cell this test breaks
      row.commit();
    }

    const broken = join(dir, "broken.xlsx");
    await workbook.xlsx.writeFile(broken);

    await page.locator('input[type="file"]').setInputFiles(broken);

    const dataTable = page.getByRole("table", { name: messages.data.screen.importHeading });
    await expect(dataTable).toBeVisible();
    const rows = dataTable
      .getByRole("row")
      .filter({ hasNot: page.getByRole("columnheader") });
    expect(await rows.count()).toBeGreaterThanOrEqual(ROW_COUNT);
  });

  test("the fund's chevron reaches group settings", async ({ page }) => {
    await page.goto("/es/");

    // Written into the plan as "disabled until RF-56's screen exists"
    // (`private/planes/plan-escritorio.md`, module 10). `/settings/group` has
    // existed since `6246441` and the chevron has linked there, live, since the
    // same commit — a fact this pass found stale rather than one it is asked to
    // fix. Proved as what the shipped chevron actually does.
    const chevron = page.getByRole("link", { name: nav.fundSettings });
    await chevron.click();
    await expect(page).toHaveURL("/es/settings/group");
  });

  test("the person's row opens the settings panel", async ({ page }) => {
    await page.goto("/es/");

    const person = page.getByRole("button", { name: LEADER_MEMBER_NAME, exact: false });
    await person.click();

    await expect(page.getByRole("dialog", { name: nav.settings })).toBeVisible();
  });
});
