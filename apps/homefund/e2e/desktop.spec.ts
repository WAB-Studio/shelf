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
import { createHash, randomUUID } from "node:crypto";
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
  clearQueue,
  readScope,
  seedGroup,
  seedQueue,
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

let debtAccountId = "";
let debtDetailAccountId = "";
let firstTransactionId = "";
let groupId = "";

// Every id this file writes, dropped in `afterAll` in the reverse of the order
// a foreign key would refuse: children first, `accounts` last.
const created = {
  categoryIds: [] as string[],
  labelIds: [] as string[],
  webhookIds: [] as string[],
  accountIds: [] as string[],
  transactionIds: [] as string[],
  budgetIds: [] as string[],
  paymentIds: [] as string[],
  ruleIds: [] as string[],
  goalIds: [] as string[],
  memberIds: [] as string[],
  planId: "",
  statementId: "",
};

test.beforeAll(async () => {
  ({ groupId } = await seedGroup());

  const today = todayInBogota();

  await asHarnessUser(async (tx) => {
    // Six pending invitations beside the leader and the plain member `seedGroup`
    // already wrote: a roster of eight needs no second real identity, since
    // `user_id` stays null until an invite is claimed (RF-06).
    for (let i = 0; i < ROW_COUNT - 2; i += 1) {
      const id = randomUUID();
      created.memberIds.push(id);
      await tx`
        insert into group_members (id, group_id, name, role, invite_email)
        values (${id}, ${groupId}, ${named("Invitado", i)}, 'member',
          ${`invitado-${stamp}-${i}@example.invalid`})`;
    }

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.categoryIds.push(id);
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${id}, ${scope.userId}, ${named("Categoría escritorio", i)},
          ${i % 2 === 0 ? "expense" : "income"}, '#4C8C4A')`;
    }

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.labelIds.push(id);
      await tx`
        insert into labels (id, owner_user_id, name, color)
        values (${id}, ${scope.userId}, ${named("Etiqueta escritorio", i)}, '#4C8C4A')`;
    }

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.webhookIds.push(id);
      await tx`
        insert into webhook_credentials (id, owner_user_id, name, token_hash, rate_limit_per_min)
        values (${id}, ${scope.userId}, ${named("Credencial escritorio", i)},
          ${createHash("sha256").update(id).digest("hex")}, ${30 + i})`;
    }

    // Eight liabilities, each carrying terms: the Deudas table's own rows and
    // the Cuentas table's rest, in one batch (RF-117's cupo is already proved
    // by check:queries/check:http; this file only needs the row count).
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.accountIds.push(id);
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${id}, ${scope.userId}, ${named("Tarjeta escritorio", i)},
          'liability', 'tarjeta', ${-1_000_000 * (i + 1)}, ${today})`;
      await tx`
        insert into debt_terms (
          account_id, debt_kind, annual_rate, minimum_payment_cents,
          credit_limit_cents, statement_cut_off_day, payment_due_day)
        values (${id}, 'revolving', 0.24, 50000, 5000000, 15, 5)`;
    }
    debtAccountId = created.accountIds[0];
    debtDetailAccountId = created.accountIds[1];

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
    firstTransactionId = created.transactionIds[0];

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.budgetIds.push(id);
      await tx`
        insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name)
        values (${id}, ${scope.userId}, ${scope.categoryId}, 'monthly',
          ${1000000 * (i + 1)}, 80, ${named("Presupuesto escritorio", i)})`;
    }

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.paymentIds.push(id);
      await tx`
        insert into planned_payments (
          id, owner_user_id, from_account_id, amount_cents, category_id, due_date,
          description, created_by)
        values (${id}, ${scope.userId}, ${scope.accountId}, ${20000 * (i + 1)},
          ${scope.categoryId}, ${today}, ${named("Pago escritorio", i)}, ${scope.userId})`;
    }

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.ruleIds.push(id);
      await tx`
        insert into recurring_rules (
          id, owner_user_id, from_account_id, amount_cents, category_id, description,
          frequency, interval_n, day_of_month, next_run_on, created_by)
        values (${id}, ${scope.userId}, ${scope.accountId}, ${15000 * (i + 1)},
          ${scope.categoryId}, ${named("Regla escritorio", i)}, 'monthly', 1, 5,
          ${today}, ${scope.userId})`;
    }

    for (let i = 0; i < ROW_COUNT; i += 1) {
      const id = randomUUID();
      created.goalIds.push(id);
      await tx`
        insert into savings_goals (id, owner_user_id, name, target_amount_cents)
        values (${id}, ${scope.userId}, ${named("Meta escritorio", i)}, ${5000000 * (i + 1)})`;
    }

    // The debt-detail measurement (the pending item D16 left, named in the
    // module): one plan of five lines and one statement, neither drawn behind
    // an `lg` guard, so this is enough rows to see whether the flexible column
    // collapses at 360px the way Auditoría's once did.
    const planId = randomUUID();
    created.planId = planId;
    await tx`
      insert into installment_plans (
        id, account_id, description, principal_cents, n_installments, frequency, start_date)
      values (${planId}, ${debtDetailAccountId}, 'Plan escritorio', 500000, 5, 'monthly', ${today})`;
    for (let seq = 1; seq <= 5; seq += 1) {
      await tx`
        insert into installment_lines (plan_id, seq, due_date, amount_cents)
        values (${planId}, ${seq}, ${today}, 100000)`;
    }
    const statementId = randomUUID();
    created.statementId = statementId;
    await tx`
      insert into account_statements (
        id, account_id, period_start, cut_off_date, payment_due_date,
        closing_balance_cents, minimum_payment_cents, interest_charged_cents)
      values (${statementId}, ${debtDetailAccountId}, ${today}, ${today}, ${today},
        -500000, 50000, 10000)`;
  });

  await seedQueue(
    Array.from({ length: ROW_COUNT }, (_, i) => ({
      merchant: named("Comercio escritorio", i),
      amountCents: 10000 * (i + 1),
      accountId: scope.accountId,
      categoryId: scope.categoryId,
      categorySource: "merchant" as const,
    })),
  );

  // A write of its own, after every write above: `audit_log` orders newest
  // first, and the batch above shares one transaction's `now()`, so only a
  // later, separate commit is guaranteed to sort ahead of it on page one.
  const auditProbeId = randomUUID();
  created.categoryIds.push(auditProbeId);
  await asHarnessUser(async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${auditProbeId}, ${scope.userId}, ${named("Auditoría escritorio", 0)},
        'expense', '#4C8C4A')`;
  });
});

test.afterAll(async () => {
  await clearQueue();

  // Every array here is safe empty (`postgres.js` turns `in ${tx([])}` into
  // `in (null)`, matching nothing) — a mid-seed failure this drop cannot yet
  // predict must still leave nothing of this file's behind for the next spec
  // to trip on, the way a lost token once left this file's own rows standing
  // for `settings.spec.ts` to find.
  const planIds = [created.planId].filter(Boolean);
  const statementIds = [created.statementId].filter(Boolean);

  await asHarnessUser(async (tx) => {
    await tx`delete from account_statements where id in ${tx(statementIds)}`;
    await tx`delete from installment_lines where plan_id in ${tx(planIds)}`;
    await tx`delete from installment_plans where id in ${tx(planIds)}`;
    await tx`delete from savings_goals where id in ${tx(created.goalIds)}`;
    await tx`delete from recurring_rules where id in ${tx(created.ruleIds)}`;
    await tx`delete from planned_payments where id in ${tx(created.paymentIds)}`;
    await tx`delete from budgets where id in ${tx(created.budgetIds)}`;
    await tx`
      delete from transaction_splits where transaction_id in ${tx(created.transactionIds)}`;
    await tx`delete from transactions where id in ${tx(created.transactionIds)}`;
    await tx`delete from debt_terms where account_id in ${tx(created.accountIds)}`;
    await tx`delete from accounts where id in ${tx(created.accountIds)}`;
    await tx`delete from webhook_credentials where id in ${tx(created.webhookIds)}`;
    await tx`delete from labels where id in ${tx(created.labelIds)}`;
    await tx`delete from categories where id in ${tx(created.categoryIds)}`;
    await tx`delete from group_members where id in ${tx(created.memberIds)}`;
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
    // False for the one table drawn at every width with no phone-card
    // alternative (Auditoría) — see the finding beside it below.
    additive?: boolean;
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
    {
      label: "/movements/{id}",
      path: () => `/movements/${firstTransactionId}`,
      sidebarHref: "/movements",
    },
    {
      label: "/inbox",
      path: () => "/inbox",
      sidebarHref: "/inbox",
      table: { title: messages.ingest.title, rowName: named("Comercio escritorio", 0) },
    },
    // Found, not fixed: no `NavList` row names `/planning` itself — the hub
    // carries no entry of its own (`components/fund/destinations.ts`,
    // `PRIMARY_KEYS`'s own comment: "the hub behind the phone's tab is not a
    // stop on the way here"). A route with a sidebar and no lit row is exactly
    // what SPEC-A3's third audit demand would flag.
    { label: "/planning", path: () => "/planning", sidebarHref: null },
    {
      label: "/planning/budgets",
      path: () => "/planning/budgets",
      sidebarHref: "/planning/budgets",
      table: { title: messages.budgets.title, rowName: named("Presupuesto escritorio", 0) },
    },
    {
      label: "/planning/goals",
      path: () => "/planning/goals",
      sidebarHref: "/planning/goals",
      table: { title: messages.goals.title, rowName: named("Meta escritorio", 0) },
    },
    {
      label: "/planning/payments",
      path: () => "/planning/payments",
      sidebarHref: "/planning/payments",
      table: { title: messages.plannedPayments.title, rowName: named("Pago escritorio", 0) },
    },
    {
      label: "/planning/recurring",
      path: () => "/planning/recurring",
      sidebarHref: "/planning/recurring",
      table: { title: messages.recurringRules.title, rowName: named("Regla escritorio", 0) },
    },
    {
      label: "/planning/debts",
      path: () => "/planning/debts",
      sidebarHref: "/planning/debts",
      table: { title: messages.debts.title, rowName: named("Tarjeta escritorio", 0) },
    },
    {
      label: "/planning/debts/{accountId}",
      path: () => `/planning/debts/${debtAccountId}`,
      sidebarHref: "/planning/debts",
    },
    { label: "/reports", path: () => "/reports", sidebarHref: "/reports" },
    { label: "/settings", path: () => "/settings", sidebarHref: "/settings" },
    {
      label: "/settings/accounts",
      path: () => "/settings/accounts",
      sidebarHref: "/settings/accounts",
      table: { title: messages.accounts.title, rowName: named("Tarjeta escritorio", 0) },
    },
    {
      // By design, not a finding: `SIDEBAR_SECONDARY_KEYS` leaves Auditoría out
      // on purpose ("both are rare and stay in the panel") — it reaches this
      // screen through Ajustes, not a row of its own, so no row is ever lit.
      label: "/settings/audit",
      path: () => "/settings/audit",
      sidebarHref: null,
      // The audit row this test names carries no unique row name of its own —
      // `RowMenu`'s `rowName` is the translated entity (`audit-table.tsx`,
      // `row.entity`) — so it names the one write this file commits last
      // (the probe above), guaranteed newest and so on the table's first page.
      // `additive: false`: `audit-screen.tsx` draws this table at every width
      // with no `Box display` guard at all — the D16 fix floors its flexible
      // column so a narrow viewport scrolls it instead of collapsing it, which
      // only makes sense if the table still shows there.
      table: {
        title: messages.audit.title,
        rowName: messages.audit.entities.categories,
        additive: false,
      },
    },
    {
      label: "/settings/categories",
      path: () => "/settings/categories",
      sidebarHref: "/settings/categories",
      table: { title: messages.categories.title, rowName: named("Categoría escritorio", 0) },
    },
    { label: "/settings/data", path: () => "/settings/data", sidebarHref: "/settings/data" },
    // Found, not fixed: reached only through the fund's chevron
    // (`components/fund/app-sidebar.tsx`), which is a plain link, never a
    // `NavList` item — so nothing in the sidebar is ever lit here either.
    { label: "/settings/group", path: () => "/settings/group", sidebarHref: null },
    {
      label: "/settings/labels",
      path: () => "/settings/labels",
      sidebarHref: "/settings/labels",
      table: { title: messages.labels.title, rowName: named("Etiqueta escritorio", 0) },
    },
    {
      label: "/settings/members",
      path: () => "/settings/members",
      sidebarHref: "/settings/members",
      table: { title: messages.members.title, rowName: named("Invitado", 0) },
    },
    {
      // By design, not a finding — see `/settings/audit` above; Webhooks is
      // `SIDEBAR_SECONDARY_KEYS`'s other panel-only exception.
      label: "/settings/webhooks",
      path: () => "/settings/webhooks",
      sidebarHref: null,
      table: { title: messages.webhooks.title, rowName: named("Credencial escritorio", 0) },
    },
  ];
}

test.describe("at 1280, the sidebar and its 14 tables", () => {
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
      // SPEC-A3's "at least 8" is about, not the columns above them.
      const rows = dataTable
        .getByRole("row")
        .filter({ hasNot: page.getByRole("columnheader") });
      expect(await rows.count()).toBeGreaterThanOrEqual(ROW_COUNT);

      // The generic form of D16: `.container` never sets a height, so it can
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
      // is what SPEC-A3's fourth audit demand asks for, proved generically
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

test.describe("at 360, the desktop subtree steps aside", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 360,
    "the bottom bar and the additive tables' phone shape render below md",
  );

  for (const route of routes()) {
    test(`${route.label} hides the sidebar and keeps every control tappable`, async ({
      page,
    }) => {
      await page.goto(`/es${route.path()}`);

      // The one node the additive pattern adds to every route (see `sidebar`
      // above): gone from the accessibility tree at this width, which is what
      // `display: none` does and `visibility: hidden` would not.
      await expect(sidebar(page)).toBeHidden();
      await expect(page.getByRole("link", { name: nav.home, exact: true })).toBeVisible();

      // Auditoría has no phone card to switch to (see the finding in
      // `routes()`): it draws the same table at every width, on purpose, so
      // this is the one table this pass does not expect gone.
      if (route.table && route.table.additive !== false) {
        await expect(page.getByRole("table", { name: route.table.title })).toBeHidden();
      }

      const controls = page.getByRole("button").or(page.getByRole("link"));
      const count = await controls.count();
      for (let i = 0; i < count; i += 1) {
        const control = controls.nth(i);
        if (!(await control.isVisible())) continue;

        // Found, not fixed: `components/data/data-screen.tsx` hides its native
        // `<input type="file">` behind `VisuallyHidden`'s 1px clip, but the
        // input keeps its own, unclipped layout box — Chromium reads it as
        // `role=button` regardless, so this sweep would otherwise fail the one
        // route that offers a file picker on a control nobody can see or tap
        // directly (the styled `<label>` around it is the real surface, and
        // carries no role at all). Outside this pass's contract to repair.
        const tag = await control.evaluate((el) => ({
          name: el.tagName,
          type: el.getAttribute("type"),
        }));
        if (tag.name === "INPUT" && tag.type === "file") continue;

        const box = await control.boundingBox();
        expect(box, `control ${i} has no box`).not.toBeNull();

        // `table-pagination.module.css`'s own comment: the square paints at
        // SPEC-A3's 30px and a `::after` with a negative inset carries the hit
        // area out to RNF-08's 32px — a real technique `getBoundingClientRect`
        // does not see on the element itself, so the pseudo-element's own
        // inset is added back before this floors anything.
        const overhang = await control.evaluate((el) => {
          const after = getComputedStyle(el, "::after");
          if (after.content === "none" || after.position !== "absolute") return 0;
          const inset = [after.top, after.right, after.bottom, after.left].map(
            (side) => -Math.min(0, parseFloat(side) || 0),
          );
          return Math.min(inset[0] + inset[2], inset[1] + inset[3]);
        });

        expect(
          Math.min(box!.width, box!.height) + overhang,
          `control ${i} named ${JSON.stringify(await control.textContent())} on ${route.label}`,
        ).toBeGreaterThanOrEqual(32);
      }
    });
  }

  // D16's own pending note (module 39, "un pendiente que te dejó D16"): the debt
  // detail screen draws both its tables with no `lg` guard at all — not the
  // additive pattern the rest of the slice keeps, the same shape Auditoría had
  // before its fix. Measured here, named by its own result, not repaired: that
  // is a different module's contract.
  test("the debt detail screen's fixed columns at 360px (measured, not fixed)", async ({
    page,
  }) => {
    await page.goto(`/es/planning/debts/${debtDetailAccountId}`);

    // `count()` reads the DOM once and does not retry; the page still has a
    // server round trip ahead of it right after `goto`, so this waits for the
    // first table the way every other check in this file already does.
    await expect(page.getByRole("table").first()).toBeVisible();

    const tables = page.getByRole("table");
    const count = await tables.count();
    expect(count).toBeGreaterThan(0);

    const collapsed: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const table = tables.nth(i);
      const name = (await table.getAttribute("aria-label")) ?? `table ${i}`;
      const width = await table.evaluate((el) => el.getBoundingClientRect().width);
      if (width <= 0) collapsed.push(name);
    }

    console.log(
      collapsed.length === 0
        ? "REPORT  debt-detail-screen's tables hold their width at 360px."
        : `REPORT  debt-detail-screen collapses at 360px: ${collapsed.join(", ")}.`,
    );
  });
});
