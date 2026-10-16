/**
 * What the cuadre-area screens draw, read back as computed style: the dashboard's
 * band, the reports cards and the movement detail. Every row passes on the commit
 * before the screens left their CSS modules and inline styles, and must pass after
 * it. The lint row is the one that starts red: it runs the screen rule over these
 * files against the real config, whose debt list has to read empty.
 *
 * A colour or a radius is compared against the token resolved by the browser
 * itself, never against a hand-copied value.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";
import { ESLint } from "eslint";

import { addCivilDays, todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, clearLedger, readScope, test } from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const SCREEN_FILES = [
  "app/[locale]/(app)/page.tsx",
  "components/reports/dashboard-summary.tsx",
  "components/reports/reports-screen.tsx",
  "components/transactions/movement-detail.tsx",
];

async function resolved(page: Page, property: string, value: string): Promise<string> {
  return page.evaluate(
    ([prop, val]) => {
      const probe = document.createElement("div");
      probe.style.setProperty(prop, val);
      (document.querySelector(".radix-themes") ?? document.body).append(probe);
      const out = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return out;
    },
    [property, value],
  );
}

async function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

async function widthOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => el.getBoundingClientRect().width);
}

function card(page: Page, name: "net" | "month" | "cash"): Locator {
  return page.locator(`[data-card="${name}"]`);
}

test.describe("dashboard band", () => {
  test("at 360 the band and its cards are not boxes and the cash card is hidden", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the phone's column");
    await page.goto("/es");
    await expect(card(page, "month")).toBeAttached();

    expect(await computed(card(page, "net"), "display")).toBe("contents");
    expect(await computed(card(page, "month"), "display")).toBe("contents");
    expect(await computed(card(page, "net").locator(".."), "display")).toBe("contents");
    expect(await computed(card(page, "cash"), "display")).toBe("none");
  });

  test("at 1280 three cards share the row 1.35 : 1 : 0.9 and the net figure is 40 px", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the laptop's row");
    await page.goto("/es");
    await expect(card(page, "net")).toBeVisible();

    expect(await computed(card(page, "net"), "flex-grow")).toBe("1.35");
    expect(await computed(card(page, "month"), "flex-grow")).toBe("1");
    expect(await computed(card(page, "cash"), "flex-grow")).toBe("0.9");

    const radius = await resolved(page, "border-top-left-radius", "16px");
    expect(await computed(card(page, "net"), "border-top-left-radius")).toBe(radius);

    const figure = card(page, "net").locator(".rt-Heading").first();
    await expect(figure).toBeVisible();
    expect(await computed(figure, "font-size")).toBe("40px");
    expect(await computed(figure, "letter-spacing")).toBe("-1.2px");
  });

  test("the month stats are three equal columns split by a hairline", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the laptop's row");
    await page.goto("/es");
    const stats = page.locator('[data-stats="3"]').first();
    await expect(stats).toBeVisible();

    const columns = stats.locator("> *");
    expect(await columns.count()).toBe(3);
    const widths = await columns.evaluateAll((els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return (
          el.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.borderLeftWidth)
        );
      }),
    );
    // Equal shares of the row: what each column holds, less its padding and seam.
    expect(Math.abs(widths[0] - widths[1])).toBeLessThan(1);
    expect(Math.abs(widths[1] - widths[2])).toBeLessThan(1);

    expect(await computed(columns.nth(0), "border-left-width")).toBe("0px");
    expect(await computed(columns.nth(1), "border-left-width")).toBe("1px");
    expect(await computed(columns.nth(2), "border-left-width")).toBe("1px");
  });
});

test.describe("dashboard band with a gap", () => {
  let accountId = "";

  test.beforeAll(async () => {
    accountId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${accountId}, ${scope.userId}, ${`Descuadre ${stamp}`}, 'asset', 'bancaria',
          50_000_000, ${addCivilDays(todayInBogota(), -1)})`;
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${accountId}, ${todayInBogota()}, 51_000_000)`;
    });
  });

  test.afterAll(async () => {
    await fixtureSql`
      delete from transactions where from_account_id = ${accountId} or to_account_id = ${accountId}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${accountId}`;
    await fixtureSql`delete from accounts where id = ${accountId}`;
  });

  test("a gap adds «Descuadre del mes» as a fourth figure in a grid", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the laptop's row");
    await page.goto("/es");
    const stats = page.locator('[data-stats="4"]').first();
    await expect(stats).toBeVisible();

    await expect(stats.getByText(messages.dashboard.monthAdjustment, { exact: true })).toBeVisible();
    expect(await stats.locator("> *").count()).toBe(4);
    expect(await computed(stats, "display")).toBe("grid");
    expect(await computed(stats.locator("> *").nth(1), "border-left-width")).toBe("0px");
  });
});

test.describe("reports cards", () => {
  test("at 1280 the cards sit on the panel background with a 16 px radius", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the laptop's cards");
    await page.goto("/es/reports");

    const trend = page
      .getByRole("heading", { name: messages.reports.comparisonTitle, exact: true })
      .locator("..");
    const lower = page
      .getByRole("heading", { name: messages.reports.byCategoryTitle, exact: true })
      .locator("..");
    await expect(trend).toBeVisible();
    await expect(lower).toBeVisible();

    const panel = await resolved(page, "background-color", "var(--color-panel-solid)");
    for (const cardLocator of [trend, lower]) {
      expect(await computed(cardLocator, "background-color")).toBe(panel);
      expect(await computed(cardLocator, "border-top-left-radius")).toBe("16px");
    }

    expect(await computed(lower.locator(".."), "display")).toBe("grid");
  });

  test("the legend dots are 12 by 12 and round", async ({ page }) => {
    await page.goto("/es/reports");

    const label = page
      .getByText(new RegExp(`^${messages.reports.legendIncome}`))
      .locator("visible=true")
      .first();
    await expect(label).toBeVisible();
    const dot = label.locator("xpath=preceding-sibling::*[1]");

    const box = await dot.boundingBox();
    expect(Math.round(box!.width)).toBe(12);
    expect(Math.round(box!.height)).toBe(12);
    expect(await computed(dot, "border-top-left-radius")).toBe(
      await resolved(page, "border-top-left-radius", "9999px"),
    );
  });
});

test.describe("movement detail", () => {
  let movementId = "";
  let adjustmentAccountId = "";
  let adjustmentId = "";

  test.beforeAll(async () => {
    movementId = randomUUID();
    adjustmentAccountId = randomUUID();
    await asHarnessUser(async (tx) => {
      await tx`
        insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
        values (${movementId}, ${scope.accountId}, 12000, ${todayInBogota()}, ${`Detalle ${stamp}`})`;
      await tx`
        insert into transaction_splits (transaction_id, category_id, amount_cents)
        values (${movementId}, ${scope.categoryId}, 12000)`;
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
        values (${adjustmentAccountId}, ${scope.userId}, ${`Ajuste ${stamp}`}, 'asset', 'bancaria',
          50_000_000, ${addCivilDays(todayInBogota(), -30)})`;
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${adjustmentAccountId}, ${addCivilDays(todayInBogota(), -1)}, 51_000_000)`;
    });
    const [row] = await fixtureSql<{ id: string }[]>`
      select id from transactions
      where reconciliation_id is not null
        and (from_account_id = ${adjustmentAccountId} or to_account_id = ${adjustmentAccountId})`;
    adjustmentId = row.id;
  });

  test.afterAll(async () => {
    await fixtureSql`
      delete from transactions
      where id = ${movementId}
        or from_account_id = ${adjustmentAccountId} or to_account_id = ${adjustmentAccountId}`;
    await fixtureSql`delete from account_reconciliations where account_id = ${adjustmentAccountId}`;
    await fixtureSql`delete from accounts where id = ${adjustmentAccountId}`;
    await clearLedger();
  });

  test("Editar and Eliminar share the row and both grow", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the phone's detail");
    await page.goto(`/es/movements/${movementId}`);

    const edit = page.getByRole("button", { name: messages.transactions.edit, exact: true });
    const remove = page.getByRole("button", { name: messages.transactions.delete, exact: true });
    await expect(edit).toBeVisible();

    expect(await computed(edit, "flex-grow")).toBe("1");
    expect(await computed(remove, "flex-grow")).toBe("1");
    const [a, b] = [await edit.boundingBox(), await remove.boundingBox()];
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(1);
    expect(Math.abs(a!.width - b!.width)).toBeLessThan(1);
  });

  test("an adjustment has no buttons row and its heading still fills the header", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the phone's detail");
    await page.goto(`/es/movements/${adjustmentId}`);

    const heading = page
      .getByRole("heading", { name: messages.transactions.kindAdjustment, exact: true })
      .locator("visible=true")
      .first();
    await expect(heading).toBeVisible();
    await expect(
      page.getByRole("button", { name: messages.transactions.edit, exact: true }),
    ).toHaveCount(0);

    const reach = await heading.evaluate((el) => {
      const row = el.closest("[class*='rt-Flex']")!;
      return row.getBoundingClientRect().right - el.getBoundingClientRect().right;
    });
    expect(Math.abs(reach)).toBeLessThan(1);
  });
});

type ConfigEntry = { files?: string[]; rules?: Record<string, unknown> };

// The entries that carve a file out of the screen rule: a syntax override that names
// files, apart from the screen block itself and the RLS harness's.
function debtEntries(entries: ConfigEntry[]): ConfigEntry[] {
  return entries.filter(
    (entry) =>
      entry.files?.length &&
      entry.rules?.["no-restricted-syntax"] !== undefined &&
      !entry.files.includes("scripts/check-rls.ts") &&
      !entry.files.includes("app/**"),
  );
}

test.describe("lint", () => {
  test("the screen rule holds on these files with no debt entry to hide them", async () => {
    const { default: config } = await import("../eslint.config.mjs");
    const entries = config as ConfigEntry[];
    const debt = new Set(debtEntries(entries));
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: true,
      overrideConfig: entries.filter((entry) => !debt.has(entry)) as never,
    });

    const results = await eslint.lintFiles(SCREEN_FILES);
    const found = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "no-restricted-syntax")
        .map((message) => `${result.filePath}:${message.line} ${message.message}`),
    );
    expect(found).toEqual([]);
  });

  test("the debt list names one file, the layout", async () => {
    const { default: config } = await import("../eslint.config.mjs");
    const files = debtEntries(config as ConfigEntry[]).flatMap((entry) => entry.files ?? []);
    expect(files).toEqual(["app/[[]locale]/layout.tsx"]);
  });
});
