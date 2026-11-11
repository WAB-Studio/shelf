/**
 * What the screens that left their inline styles draw, read back as computed
 * style: every row passes on the commit before the refactor and must pass after
 * it, so the move onto `components/ui` changes no pixel a person sees. The lint
 * row is the one that starts red: it runs the screen rule over the 17 files with
 * no debt entry to hide them.
 *
 * A colour or a radius is compared against the token resolved by the browser
 * itself, never against a hand-copied value.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";
import { ESLint } from "eslint";

import { todayInBogota } from "@/lib/dates";
import messages from "@/messages/es.json";

import { nameLayout } from "./name-layout";

import {
  asHarnessUser,
  clearGroup,
  clearQueue,
  readScope,
  seedGroup,
  seedQueue,
  test,
} from "./global-setup";

const scope = readScope();
const stamp = randomUUID().slice(0, 8);

const SCREEN_FILES = [
  "app/[locale]/(app)/error.tsx",
  "app/[locale]/bienvenida/page.tsx",
  "components/cash/withdraw-dialog.tsx",
  "components/ingest/delivery-card.tsx",
  "components/ingest/silenced-shapes.tsx",
  "components/onboarding/onboarding-stepper.tsx",
  "components/planning/budget-form-dialog.tsx",
  "components/planning/budgets-screen.tsx",
  "components/planning/budgets-table.tsx",
  "components/planning/debts-screen.tsx",
  "components/planning/goals-screen.tsx",
  "components/planning/goals-table.tsx",
  "components/planning/payments-screen.tsx",
  "components/planning/planning-hub.tsx",
  "components/planning/recurring-screen.tsx",
  "components/transactions/movement-form.tsx",
  "components/transactions/split-editor.tsx",
];

// A token with no space in it: the one shape that overflows a card unless the
// text wraps anywhere.
const LONG_TOKEN = "TOKEN".repeat(12);

const names = {
  overspent: `Presupuesto excedido ${stamp}`,
  within: `Presupuesto holgado ${stamp}`,
  active: `Regla activa ${stamp}`,
  paused: `Regla en pausa ${stamp}`,
  payment: `Pago pendiente ${stamp}`,
  goal: `Meta ${stamp}`,
  debt: `Mastercard Black Bancolombia ${stamp}`,
  usd: `Cuenta USD ${stamp}`,
};

const created = {
  categoryIds: [] as string[],
  budgetIds: [] as string[],
  transactionIds: [] as string[],
  ruleIds: [] as string[],
  paymentIds: [] as string[],
  goalIds: [] as string[],
  accountIds: [] as string[],
  shapeIds: [] as string[],
};

test.beforeAll(async () => {
  // The welcome and the last onboarding step both presuppose a fund.
  await seedGroup();

  const today = todayInBogota();
  const categories = { over: randomUUID(), within: randomUUID() };

  await asHarnessUser(async (tx) => {
    for (const [key, id] of Object.entries(categories)) {
      created.categoryIds.push(id);
      await tx`
        insert into categories (id, owner_user_id, name, kind, color)
        values (${id}, ${scope.userId}, ${`Categoría ${key} ${stamp}`}, 'expense', '#4C8C4A')`;
    }

    // One limit already crossed and one nowhere near: a tone that is always on,
    // or never, fails one of the two.
    const budgets = [
      { name: names.overspent, category: categories.over, limit: 100_000 },
      { name: names.within, category: categories.within, limit: 90_000_000 },
    ];
    for (const budget of budgets) {
      const id = randomUUID();
      created.budgetIds.push(id);
      await tx`
        insert into budgets (id, owner_user_id, category_id, period, limit_cents, threshold_pct, name)
        values (${id}, ${scope.userId}, ${budget.category}, 'monthly', ${budget.limit}, 80, ${budget.name})`;
    }

    const spend = randomUUID();
    created.transactionIds.push(spend);
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description)
      values (${spend}, ${scope.accountId}, 300000, ${today}, ${`Gasto ${stamp}`})`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${spend}, ${categories.over}, 300000)`;

    const rules = [
      { name: names.active, active: true },
      { name: names.paused, active: false },
    ];
    for (const rule of rules) {
      const id = randomUUID();
      created.ruleIds.push(id);
      await tx`
        insert into recurring_rules (
          id, owner_user_id, from_account_id, amount_cents, category_id, description,
          frequency, interval_n, day_of_month, next_run_on, is_active, created_by)
        values (${id}, ${scope.userId}, ${scope.accountId}, 15000, ${scope.categoryId},
          ${rule.name}, 'monthly', 1, 5, ${today}, ${rule.active}, ${scope.userId})`;
    }

    // A movement the active rule generated and nobody reviewed: the screen's
    // callout leads to it.
    const generated = randomUUID();
    created.transactionIds.push(generated);
    await tx`
      insert into transactions (id, from_account_id, amount_cents, occurred_at, description, recurring_rule_id)
      values (${generated}, ${scope.accountId}, 15000, ${today}, ${`Generado ${stamp}`}, ${created.ruleIds[0]})`;
    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${generated}, ${scope.categoryId}, 15000)`;

    const payment = randomUUID();
    created.paymentIds.push(payment);
    await tx`
      insert into planned_payments (
        id, owner_user_id, from_account_id, amount_cents, category_id, due_date, description, created_by)
      values (${payment}, ${scope.userId}, ${scope.accountId}, 20000, ${scope.categoryId},
        ${today}, ${names.payment}, ${scope.userId})`;

    const goal = randomUUID();
    created.goalIds.push(goal);
    await tx`
      insert into savings_goals (id, owner_user_id, name, target_amount_cents)
      values (${goal}, ${scope.userId}, ${names.goal}, 5000000)`;
    await tx`
      insert into goal_contributions (goal_id, transaction_id, amount_cents)
      values (${goal}, null, 1000000)`;

    const debt = randomUUID();
    created.accountIds.push(debt);
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${debt}, ${scope.userId}, ${names.debt}, 'liability', 'card', -1000000, ${today})`;
    await tx`
      insert into debt_terms (
        account_id, debt_kind, annual_rate, minimum_payment_cents,
        credit_limit_cents, statement_cut_off_day, payment_due_day)
      values (${debt}, 'revolving', 0.24, 50000, 5000000, 15, 5)`;

    // The other side of a transfer in a currency the movement is not in.
    const usd = randomUUID();
    created.accountIds.push(usd);
    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, settlement_currency, initial_balance_cents, initial_balance_on)
      values (${usd}, ${scope.userId}, ${names.usd}, 'asset', 'bank', 'USD', 0, ${today})`;

    created.shapeIds.push(randomUUID());
  });

  await seedQueue([
    {
      merchant: `Comercio ${stamp}`,
      amountCents: 12_000,
      accountId: scope.accountId,
      categoryId: scope.categoryId,
      categorySource: "merchant",
      text: `Compra ${LONG_TOKEN}`,
    },
  ]);
  // `seedQueue` clears the shapes too; the silenced one goes back in after it.
  await asHarnessUser(async (tx) => {
    await tx`delete from ingest_shapes where id in ${tx(created.shapeIds)}`;
    await tx`
      insert into ingest_shapes (id, owner_user_id, shape_hash, decision, sample_text)
      values (${created.shapeIds[0]}, ${scope.userId}, ${"a".repeat(64)}, 'rejected', ${`Compra ${LONG_TOKEN}`})`;
  });
});

test.afterAll(async () => {
  await clearQueue();

  await asHarnessUser(async (tx) => {
    await tx`delete from goal_contributions where goal_id in ${tx(created.goalIds)}`;
    await tx`delete from savings_goals where id in ${tx(created.goalIds)}`;
    await tx`delete from planned_payments where id in ${tx(created.paymentIds)}`;
    await tx`delete from transaction_splits where transaction_id in ${tx(created.transactionIds)}`;
    await tx`delete from transactions where id in ${tx(created.transactionIds)}`;
    await tx`delete from recurring_rules where id in ${tx(created.ruleIds)}`;
    await tx`delete from budgets where id in ${tx(created.budgetIds)}`;
    await tx`delete from debt_terms where account_id in ${tx(created.accountIds)}`;
    await tx`delete from accounts where id in ${tx(created.accountIds)}`;
    await tx`delete from categories where id in ${tx(created.categoryIds)}`;
  });

  await clearGroup();
});

/** What the browser computes for `property: value`, a token included. */
async function resolved(page: Page, property: string, value: string): Promise<string> {
  return page.evaluate(
    ([prop, val]) => {
      const probe = document.createElement("div");
      probe.style.setProperty(prop, val);
      // The Radix tokens (`--radius-5`, `--accent-9`) live on the theme root, not on `:root`.
      (document.querySelector(".radix-themes") ?? document.body).append(probe);
      const out = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return out;
    },
    [property, value],
  );
}

async function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el, prop) => getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

/** The visible descendants of `root` that measure exactly `size` square. */
async function squares(root: Locator, size: number): Promise<Locator> {
  const marked = await root.evaluate((el, px) => {
    let count = 0;
    el.querySelectorAll<HTMLElement>("*").forEach((node) => {
      const box = node.getBoundingClientRect();
      node.removeAttribute("data-probe-square");
      if (Math.round(box.width) === px && Math.round(box.height) === px) {
        node.setAttribute("data-probe-square", "");
        count += 1;
      }
    });
    return count;
  }, size);
  expect(marked).toBeGreaterThan(0);
  return root.locator("[data-probe-square]").first();
}

async function noOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function mobileOnly(project: string): boolean {
  return project === "mobile";
}


test.describe("planning hub", () => {
  test("on the phone a destination is a plain link tile and none overflows @mobile", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's one column");
    await page.goto("/es/planning");

    const link = page.locator("main a[href*='/planning/debts']").locator("visible=true").first();
    await expect(link).toBeVisible();
    expect(await computed(link, "text-decoration-line")).toBe("none");

    for (const tile of await page.locator("main a[href*='/planning/']").locator("visible=true").all()) {
      const [scrollWidth, clientWidth] = await tile.evaluate((el) => [el.scrollWidth, el.clientWidth]);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    }
  });
});

test.describe("debts", () => {
  test("the owed total is tabular, the disc is 42 square, the name wraps whole and the cut-off column reads right @mobile", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's cards");
    await page.goto("/es/planning/debts");

    const heading = page.getByRole("heading", { level: 2 }).filter({ hasText: /\$/ }).first();
    expect(await computed(heading, "font-variant-numeric")).toContain("tabular-nums");

    const name = page.getByText(names.debt, { exact: true }).locator("visible=true").first();
    await expect(name).toBeVisible();
    expect(await computed(name, "text-overflow")).not.toBe("ellipsis");
    expect(await computed(name, "white-space")).not.toBe("nowrap");
    expect(await computed(name, "overflow-wrap")).not.toBe("anywhere");
    expect(await computed(name, "word-break")).not.toBe("break-all");

    // No word is cut: every character of a word sits on the one line.
    const { split } = await nameLayout(name);
    expect(split).toEqual([]);

    const card = page.locator(".rt-Card:visible").filter({ hasText: names.debt }).first();
    const disc = await squares(card, 42);
    expect(await computed(disc, "border-top-left-radius")).toBe(
      await resolved(page, "border-top-left-radius", "var(--radius-5)"),
    );

    const cutOff = card.getByText(messages.debts.cutOff, { exact: true });
    expect(await computed(cutOff, "text-align")).toBe("right");
    const value = card.getByText(messages.debts.minimumPayment, { exact: true });
    expect(await computed(value, "text-align")).not.toBe("right");

    await noOverflow(page);
  });
});

test.describe("budgets", () => {
  test("a budget within its limit has no wash and an overspent one is washed red @mobile", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's cards");
    await page.goto("/es/planning/budgets");

    const within = page.locator(".rt-Card").filter({ hasText: names.within }).first();
    const over = page.locator(".rt-Card").filter({ hasText: names.overspent }).first();
    await expect(within).toBeVisible();

    expect(await computed(within, "background-color")).toBe(
      await resolved(page, "background-color", "transparent"),
    );
    expect(await computed(over, "background-color")).toBe(
      await resolved(page, "background-color", "var(--red-a2)"),
    );

    const spent = within.getByText(/^\$\s[\d.,]+\s\/\s\$/).first();
    expect(await computed(spent, "font-variant-numeric")).toContain("tabular-nums");
    // The name wraps to a second line instead of being cut.
    expect(await computed(within.getByText(names.within, { exact: true }), "text-overflow")).not.toBe(
      "ellipsis",
    );
  });
});

test.describe("goals", () => {
  test("the saved figure is tabular and the title truncates @mobile", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's cards");
    await page.goto("/es/planning/goals");

    const card = page.locator(".rt-Card").filter({ hasText: names.goal }).first();
    await expect(card).toBeVisible();
    expect(await computed(card.getByText(names.goal, { exact: true }), "text-overflow")).toBe(
      "ellipsis",
    );
    const saved = card.getByText(/^\$\s10\.000$/);
    expect(await computed(saved, "font-variant-numeric")).toContain("tabular-nums");
  });
});

test.describe("inbox", () => {
  test("a long SMS wraps inside its card @mobile", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "360px");
    await page.goto("/es/inbox");

    const card = page.locator(".rt-Card").filter({ hasText: `Comercio ${stamp}` }).first();
    await card.getByRole("button", { name: messages.ingest.showRawText }).click();
    const body = card.getByText(`Compra ${LONG_TOKEN}`, { exact: true });
    await expect(body).toBeVisible();
    expect(await computed(body, "white-space")).toBe("pre-wrap");
    expect(await computed(body, "overflow-wrap")).toBe("anywhere");
    await noOverflow(page);
  });
});

test.describe("lint", () => {
  test("the 17 files pass the screen rule with no debt entry", async () => {
    test.setTimeout(120_000);

    const { default: config } = await import("../eslint.config.mjs");
    // Drop the debt block: the one that relaxes the screen rule for named files.
    const withoutDebt = (config as { files?: string[]; rules?: Record<string, unknown> }[]).filter(
      (entry) => !entry.files?.some((glob) => glob.includes("[[]locale]/layout.tsx")),
    );
    const eslint = new ESLint({
      cwd: process.cwd(),
      overrideConfigFile: true,
      overrideConfig: withoutDebt as never,
    });

    const results = await eslint.lintFiles(SCREEN_FILES);
    const found = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === "no-restricted-syntax")
        .map((message) => `${result.filePath}:${message.line} ${message.message}`),
    );
    expect(found).toEqual([]);
  });
});
