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
  test("a destination row is a plain link and its disc is 44 square with the fifth radius", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's row");
    await page.goto("/es/planning");

    const link = page.locator("main a[href*='/planning/debts']").first();
    await expect(link).toBeVisible();
    expect(await computed(link, "text-decoration-line")).toBe("none");

    const disc = await squares(link, 44);
    expect(await computed(disc, "border-top-left-radius")).toBe(
      await resolved(page, "border-top-left-radius", "var(--radius-5)"),
    );
    expect(await computed(disc, "flex-shrink")).toBe("0");
  });

  test("a summary line truncates and the row does not overflow", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's row");
    await page.goto("/es/planning");

    const link = page.locator("main a[href*='/planning/']").first();
    const truncating = link.locator("span.rt-truncate:visible");
    await expect(truncating.first()).toBeVisible();
    for (const node of await truncating.all()) {
      expect(await computed(node, "text-overflow")).toBe("ellipsis");
    }
    const [scrollWidth, clientWidth] = await link.evaluate((el) => [
      el.scrollWidth,
      el.clientWidth,
    ]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});

test.describe("debts", () => {
  test("the owed total is tabular, the disc is 42 square, the name wraps whole and the cut-off column reads right", async ({
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

  test("the owed figure of a card is tabular", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's cards");
    await page.goto("/es/planning/debts");

    const card = page.locator(".rt-Card:visible").filter({ hasText: names.debt }).first();
    const owed = card.getByText(/^\$\s[\d.,]+$/).first();
    expect(await computed(owed, "font-variant-numeric")).toContain("tabular-nums");
  });
});

test.describe("budgets", () => {
  test("a budget within its limit has no wash and an overspent one is washed red", async ({
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
    expect(await computed(within.getByText(names.within, { exact: true }), "text-overflow")).toBe(
      "ellipsis",
    );
  });

  test("the month label opens with a capital taken from the string, not from CSS", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's month bar");
    await page.goto("/es/planning/budgets");

    const label = page
      .getByRole("button", { name: messages.budgets.previousMonth })
      .locator("xpath=following-sibling::*[1]");
    const text = (await label.textContent()) ?? "";
    expect(text.charAt(0)).toBe(text.charAt(0).toLocaleUpperCase("es"));
    expect(text.charAt(0)).not.toBe(text.charAt(0).toLocaleLowerCase("es"));
    expect(await computed(label, "text-transform")).toBe("none");
  });

  test("the threshold slider fills its row and its value is tabular", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's form");
    await page.goto("/es/planning/budgets");

    await page.getByRole("button", { name: messages.budgets.add }).first().click();
    const dialog = page.getByRole("dialog");
    const slider = dialog.getByRole("slider");
    await expect(slider).toBeVisible();

    const root = slider.locator("xpath=ancestor::span[contains(@class,'rt-SliderRoot')]");
    const [sliderWidth, rowWidth] = await root.evaluate((el) => [
      el.getBoundingClientRect().width,
      (el.parentElement?.parentElement ?? el).getBoundingClientRect().width,
    ]);
    // The value beside it is about three characters wide; the slider takes the rest.
    expect(sliderWidth / rowWidth).toBeGreaterThan(0.7);

    const value = dialog.getByText(/%/).last();
    expect(await computed(value, "font-variant-numeric")).toContain("tabular-nums");
  });

  test("the «en COP» cell never wraps (laptop tables)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the dense table");
    for (const path of ["/es/planning/budgets", "/es/planning/goals"]) {
      await page.goto(path);
      const cell = page.getByText(/^en COP$/).locator("visible=true").first();
      await expect(cell).toBeVisible();
      expect(await computed(cell, "white-space")).toBe("nowrap");
    }
  });
});

test.describe("goals", () => {
  test("the saved figure is tabular and the title truncates", async ({ page }, testInfo) => {
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

test.describe("payments", () => {
  test("the month eyebrow is upper case with 0.06em spacing and the day tile is 44 square with a 14px radius", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's cards");
    await page.goto("/es/planning/payments");

    const card = page.locator(".rt-Card").filter({ hasText: names.payment }).first();
    await expect(card).toBeVisible();

    const tile = await squares(card, 44);
    expect(await computed(tile, "border-top-left-radius")).toBe("14px");

    const eyebrow = page
      .locator("main")
      .getByText(/^[\p{L}]+\s+(de\s+)?\d{4}$/u)
      .first();
    expect(await computed(eyebrow, "text-transform")).toBe("uppercase");
    const spacing = parseFloat(await computed(eyebrow, "letter-spacing"));
    const size = parseFloat(await computed(eyebrow, "font-size"));
    expect(spacing / size).toBeCloseTo(0.06, 2);
  });
});

test.describe("recurring rules", () => {
  test("an active rule is opaque, a paused one is dimmed to 0.55", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's cards");
    await page.goto("/es/planning/recurring");

    for (const [name, opacity] of [
      [names.active, "1"],
      [names.paused, "0.55"],
    ] as const) {
      const text = page.getByText(name, { exact: true }).first();
      await expect(text).toBeVisible();
      const dimmed = await text.evaluate((el) => {
        let node: Element | null = el;
        while (node) {
          const value = getComputedStyle(node).opacity;
          if (value !== "1") return value;
          node = node.parentElement;
        }
        return "1";
      });
      expect(dimmed).toBe(opacity);
    }
  });

  test("the unreviewed callout is a link with no underline", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's page");
    await page.goto("/es/planning/recurring");

    const link = page.locator("main a[href*='unreviewed=1']").first();
    await expect(link).toBeVisible();
    expect(await computed(link, "text-decoration-line")).toBe("none");
  });
});

test.describe("inbox", () => {
  test("a long SMS wraps inside its card", async ({ page }, testInfo) => {
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

  test("a silenced sample wraps the same way", async ({ page }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "360px");
    await page.goto("/es/inbox");

    const toggles = page.getByRole("button", { name: messages.ingest.showRawText });
    await toggles.last().click();
    const bodies = page.getByText(`Compra ${LONG_TOKEN}`, { exact: true });
    const last = bodies.last();
    await expect(last).toBeVisible();
    expect(await computed(last, "white-space")).toBe("pre-wrap");
    expect(await computed(last, "overflow-wrap")).toBe("anywhere");
    await noOverflow(page);
  });
});

test.describe("welcome", () => {
  test("the check disc is 96 square and round", async ({ page }) => {
    await page.goto("/es/bienvenida");

    const disc = await squares(page.locator("main"), 96);
    expect(await computed(disc, "border-top-left-radius")).not.toBe("0px");
    const [width, radius] = await disc.evaluate((el) => [
      el.getBoundingClientRect().width,
      parseFloat(getComputedStyle(el).borderTopLeftRadius),
    ]);
    expect(radius).toBeGreaterThanOrEqual(width / 2);
    expect(await computed(disc, "background-color")).toBe(
      await resolved(page, "background-color", "var(--accent-9)"),
    );
  });
});

test.describe("withdraw", () => {
  test("the row spans the card, reads from the start and shows a pointer", async ({
    page,
  }, testInfo) => {
    test.skip(!mobileOnly(testInfo.project.name), "the phone's dashboard");
    await page.goto("/es");

    const row = page.getByRole("button", { name: messages.cash.withdrawAction }).first();
    await expect(row).toBeVisible();
    const [width, parentWidth] = await row.evaluate((el) => [
      el.getBoundingClientRect().width,
      el.parentElement!.getBoundingClientRect().width,
    ]);
    expect(Math.abs(width - parentWidth)).toBeLessThanOrEqual(1);
    expect(await computed(row, "text-align")).toBe("start");
    expect(await computed(row, "cursor")).toBe("pointer");
  });
});

test.describe("onboarding stepper", () => {
  test("on step three the first two discs are checked, the third is the accent and the connectors are 2px", async ({
    page,
  }) => {
    await page.goto("/es/onboarding/invite");

    const main = page.locator("main");
    const accent = await resolved(page, "background-color", "var(--accent-9)");

    const discs = await main.evaluate((el) => {
      const found: { bg: string; checked: boolean; radius: number; width: number }[] = [];
      el.querySelectorAll<HTMLElement>("*").forEach((node) => {
        const box = node.getBoundingClientRect();
        if (Math.round(box.width) === 32 && Math.round(box.height) === 32) {
          found.push({
            bg: getComputedStyle(node).backgroundColor,
            checked: node.querySelector("svg") !== null,
            radius: parseFloat(getComputedStyle(node).borderTopLeftRadius),
            width: box.width,
          });
        }
      });
      return found;
    });
    expect(discs).toHaveLength(3);
    expect(discs.map((d) => d.bg)).toEqual([accent, accent, accent]);
    expect(discs.map((d) => d.checked)).toEqual([true, true, false]);
    expect(discs.every((d) => d.radius >= d.width / 2)).toBe(true);

    const connectors = await main.evaluate((el) => {
      const heights: number[] = [];
      el.querySelectorAll<HTMLElement>("*").forEach((node) => {
        const box = node.getBoundingClientRect();
        if (Math.round(box.height) === 2 && box.width > 8) heights.push(box.height);
      });
      return heights;
    });
    expect(connectors).toEqual([2, 2]);
  });
});

test.describe("movement form", () => {
  // The quick sheet's «¿Ingreso o traspaso?» link raises the full form, and an
  // origin turns it into an expense, which is what shows the splits.
  async function openExpenseForm(page: Page): Promise<Locator> {
    await page.goto("/es");
    await page
      .getByRole("button", { name: messages.transactions.quickPlaceholder, exact: true })
      .first()
      .click();
    await page.getByRole("dialog").getByText(messages.transactions.quickTypeLink).click();

    const form = page.getByRole("dialog");
    await form
      .getByRole("combobox", { name: messages.transactions.fromLabel, exact: true })
      .click();
    await page.getByRole("option", { name: scope.accountName, exact: true }).click();
    // The sheet carries its account over as the destination too; a transfer has
    // no category to split.
    const to = form.getByRole("combobox", { name: messages.transactions.toLabel, exact: true });
    if ((await to.textContent()) !== messages.transactions.accountNone) {
      await to.click();
      await page.getByRole("option", { name: messages.transactions.accountNone, exact: true }).click();
    }
    await form
      .getByRole("textbox", { name: messages.transactions.amountLabel, exact: true })
      .fill("45910");
    return form;
  }

  test("the header figure is tabular", async ({ page }) => {
    const form = await openExpenseForm(page);

    const figure = form.getByRole("heading", { level: 1 }).filter({ hasText: /\$/ }).first();
    await expect(figure).toBeVisible();
    expect(await computed(figure, "font-variant-numeric")).toContain("tabular-nums");
  });

  test("the split amount is 110px wide and tabular", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the phone's row is narrower than the field");
    const form = await openExpenseForm(page);

    const amount = form.getByRole("textbox", {
      name: messages.transactions.splitRowAmount.replace("{position}", "1"),
      exact: true,
    });
    await expect(amount).toBeVisible();
    const field = amount.locator("xpath=ancestor::div[contains(@class,'rt-TextFieldRoot')][1]");
    const width = await field.evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.round(width)).toBe(110);
    expect(await computed(amount, "font-variant-numeric")).toContain("tabular-nums");
  });

  test("the exchange-rate line is tabular", async ({ page }) => {
    await page.goto("/es");
    await page
      .getByRole("button", { name: messages.transactions.quickPlaceholder, exact: true })
      .first()
      .click();
    await page.getByRole("dialog").getByText(messages.transactions.quickTypeLink).click();

    const form = page.getByRole("dialog");
    await form
      .getByRole("combobox", { name: messages.transactions.fromLabel, exact: true })
      .click();
    await page.getByRole("option", { name: scope.accountName, exact: true }).click();
    await form
      .getByRole("combobox", { name: messages.transactions.toLabel, exact: true })
      .click();
    await page.getByRole("option", { name: names.usd, exact: true }).click();
    await form
      .getByRole("textbox", { name: messages.transactions.amountLabel, exact: true })
      .fill("40000");
    await form.locator("#movement-counter-amount").fill("10");

    const line = form
      .getByText(messages.transactions.rateLabel, { exact: true })
      .locator("xpath=following-sibling::span[1]");
    await expect(line).toBeVisible();
    expect(await computed(line, "font-variant-numeric")).toContain("tabular-nums");
  });

  test("the remainder is washed green at zero and red otherwise", async ({ page }) => {
    const form = await openExpenseForm(page);

    const amount = form.getByRole("textbox", {
      name: messages.transactions.splitRowAmount.replace("{position}", "1"),
      exact: true,
    });
    const remainder = form
      .getByText(messages.transactions.splitUnassigned, { exact: true })
      .locator("xpath=..");
    const figure = remainder.locator("span").last();

    await expect
      .poll(() => computed(remainder, "background-color"))
      .toBe(await resolved(page, "background-color", "var(--grass-a3)"));
    expect(await computed(figure, "font-variant-numeric")).toContain("tabular-nums");

    // A lone split mirrors the total; a second row lets the first one drift.
    await form.getByRole("button", { name: messages.transactions.splitAddCategory }).click();
    await amount.fill("1000");
    await expect
      .poll(() => computed(remainder, "background-color"))
      .toBe(await resolved(page, "background-color", "var(--red-a3)"));
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
