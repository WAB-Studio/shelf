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

async function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
}

function card(page: Page, name: "net" | "month"): Locator {
  return page.locator(`[data-card="${name}"]`);
}

test.describe("dashboard band", () => {
  test("at 360 the net card is the one box, the month card is not @mobile", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the phone's column");
    await page.goto("/es");
    await expect(card(page, "month")).toBeAttached();

    expect(await computed(card(page, "net"), "display")).toBe("flex");
    expect(await computed(card(page, "month"), "display")).toBe("contents");
    expect(await computed(card(page, "net").locator(".."), "display")).toBe("contents");
  });

  test("at 1280 the net card takes the row, the month card sits under it and the net figure is display-sized", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the laptop's row");
    await page.goto("/es");
    await expect(card(page, "net")).toBeVisible();

    expect(await computed(card(page, "net"), "flex-grow")).toBe("1.35");
    expect(await computed(card(page, "month"), "flex-grow")).toBe("1");
    expect(await page.locator(`[data-card="cash"]`).count()).toBe(0);

    expect(await computed(card(page, "net"), "border-top-left-radius")).toBe("20px");

    const figure = card(page, "net").locator(".rt-Heading").first();
    await expect(figure).toBeVisible();
    expect(parseFloat(await computed(figure, "font-size"))).toBeGreaterThanOrEqual(44);
    
  });
});

test.describe("movement detail", () => {
  let movementId = "";
  let adjustmentAccountId = "";

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
        values (${adjustmentAccountId}, ${scope.userId}, ${`Ajuste ${stamp}`}, 'asset', 'bank',
          50_000_000, ${addCivilDays(todayInBogota(), -30)})`;
      await tx`
        insert into account_reconciliations (account_id, reconciled_on, counted_balance_cents)
        values (${adjustmentAccountId}, ${addCivilDays(todayInBogota(), -1)}, 51_000_000)`;
    });
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

  test("Editar and Eliminar share the row and both grow @mobile", async ({ page }, testInfo) => {
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

// A regression row for the phone sweep, outside the header's before/after contract:
// it is red on every commit before the figure was capped to its card.
test.describe("dashboard band on a narrow phone", () => {
  const accountId = randomUUID();

  // Owed in dollars, so the dollar net worth is the longest figure the card draws:
  // «−US$ 1.222.222.221,23».
  test.beforeAll(async () => {
    await asHarnessUser(async (tx) => {
      await tx`
        insert into accounts (
          id, owner_user_id, name, kind, subtype, initial_balance_cents,
          initial_balance_on, settlement_currency)
        values (
          ${accountId}, ${scope.userId}, ${`Dólares ${stamp}`}, 'liability', 'loan',
          -122222222123, ${todayInBogota()}, 'USD')`;
    });
  });

  test.afterAll(async () => {
    await asHarnessUser(async (tx) => {
      await tx`delete from accounts where id = ${accountId}`;
    });
  });

  test("a billion-dollar net worth stays inside the net card @mobile", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the phone's column");
    await page.goto("/es");

    const net = card(page, "net");
    const figure = net.locator(".rt-Heading").filter({ hasText: "1.222.222.221,23" });
    await expect(figure).toBeVisible();

    // The text's own boxes, not the heading's: a block heading ends at the card's
    // edge whatever its text does.
    const overflow = await figure.evaluate((heading) => {
      const card = heading.closest("[data-card]")!;
      const style = getComputedStyle(card);
      const inner = card.getBoundingClientRect().right - parseFloat(style.paddingRight);
      const range = document.createRange();
      range.selectNodeContents(heading);
      return Math.max(...[...range.getClientRects()].map((rect) => rect.right)) - inner;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });
});
