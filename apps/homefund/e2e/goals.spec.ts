/**
 * The four claims the Metas screen makes about money it never stores (RF-87,
 * RF-119, RNF-07): every bar says whose goal it is and how far it stands, a goal
 * that has fallen under the straight line to its target date reads as atrasada,
 * the table's total states what the rows on screen add up to, and undoing one
 * aporte takes that aporte and nothing else. The last is a silent-money-loss path
 * — a removal that reaches the wrong row lowers a figure nobody is watching — so
 * the cents are read back from Postgres and not only from the screen that wrote
 * them.
 *
 * That straight line runs from the day a goal opened, so one goal here is opened
 * months back: `savings_goals_set_timestamps` keeps a `created_at` the INSERT
 * names and still stamps `now()` for one that names none (migration 0029). The
 * seam is open to the owner connection these fixtures run over and shut to an
 * `authenticated` caller, whose INSERT grant names no `created_at`. No test here
 * disables a trigger.
 */
import { randomUUID } from "node:crypto";

import { expect, type Locator } from "@playwright/test";

import { TIME_ZONE } from "@/lib/locales";
import messages from "@/messages/es.json";

import { fixtureSql } from "../scripts/harness/fixtures";
import { asHarnessUser, readScope, test } from "./global-setup";

const goals = messages.goals;
const common = messages.common;

const scope = readScope();

// Unique per run, so a name asserted on screen can only be this test's row.
const stamp = randomUUID().slice(0, 8);

/**
 * The five goals the screen is read against. `days` is how long ago each aporte
 * was written, which is the order the undo list shows them in — the oldest is
 * last there, and it is the one the removal test picks. `openedDaysAgo` is the
 * day the goal was opened, which is where its ritmo starts counting: a goal
 * opened today has spent none of its span and cannot read as atrasada.
 */
const SEED = [
  {
    key: "undo",
    name: `Meta con aportes ${stamp}`,
    targetCents: 200_000_000,
    openedDaysAgo: 0,
    dated: true,
    contributions: [
      { amountCents: 30_000_000, days: 0 },
      { amountCents: 20_000_000, days: 1 },
      { amountCents: 10_000_000, days: 2 },
    ],
  },
  {
    key: "neighbour",
    name: `Meta vecina ${stamp}`,
    targetCents: 100_000_000,
    openedDaysAgo: 0,
    dated: true,
    contributions: [{ amountCents: 40_000_000, days: 0 }],
  },
  {
    key: "reached",
    name: `Meta cumplida ${stamp}`,
    targetCents: 50_000_000,
    openedDaysAgo: 0,
    dated: true,
    contributions: [{ amountCents: 50_000_000, days: 0 }],
  },
  {
    key: "undated",
    name: `Meta sin fecha ${stamp}`,
    targetCents: 80_000_000,
    openedDaysAgo: 0,
    dated: false,
    contributions: [{ amountCents: 20_000_000, days: 0 }],
  },
  // Two thirds of its span already spent and a tenth of its meta set aside: the
  // straight line from the day it opened to the day it is due leaves it behind.
  {
    key: "behind",
    name: `Meta atrasada ${stamp}`,
    targetCents: 100_000_000,
    openedDaysAgo: 180,
    dated: true,
    contributions: [{ amountCents: 10_000_000, days: 0 }],
  },
] as const;

// What each goal has set aside, which is what its bar and its apartado read.
function savedOf(goal: (typeof SEED)[number]): number {
  return goal.contributions.reduce((sum, row) => sum + row.amountCents, 0);
}

// The whole percent the bar names, capped where the screen caps it (RF-87).
function pctOf(goal: (typeof SEED)[number]): number {
  return Math.min(Math.round((savedOf(goal) * 100) / goal.targetCents), 100);
}

const goalIds = new Map<string, string>();

/**
 * The seed goes in as the owner while speaking for the harness user, which is
 * what the stamping triggers read. `created_at` is named on both tables: on a
 * goal it fixes the day its ritmo counts from, and on an aporte it dates the
 * entry the undo list orders by.
 */
test.beforeEach(async () => {
  const claims = JSON.stringify({
    sub: scope.userId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;

    for (const goal of SEED) {
      const [row] = await tx<{ id: string }[]>`
        insert into savings_goals (owner_user_id, name, target_amount_cents, target_date, created_at)
        values (
          ${scope.userId},
          ${goal.name},
          ${goal.targetCents},
          ${goal.dated ? tx`(now() at time zone ${TIME_ZONE})::date + 90` : null},
          now() - make_interval(days => ${goal.openedDaysAgo}::int))
        returning id`;

      goalIds.set(goal.key, row.id);

      for (const contribution of goal.contributions) {
        await tx`
          insert into goal_contributions (goal_id, transaction_id, amount_cents, created_at)
          values (
            ${row.id},
            null,
            ${contribution.amountCents},
            now() - make_interval(days => ${contribution.days}::int))`;
      }
    }
  });
});

test.afterEach(async () => {
  const ids = [...goalIds.values()];
  goalIds.clear();

  if (ids.length === 0) return;

  // The aportes are named before their goals even though they cascade: one that
  // outlived its goal would be a leak no later count could explain. Under the
  // caller's claims, so the trail rows this drop stamps name an actor the next
  // run's purge can find again.
  await asHarnessUser(async (tx) => {
    await tx`delete from goal_contributions where goal_id in ${tx(ids)}`;
    await tx`delete from savings_goals where id in ${tx(ids)}`;
  });
});

test("names every progress bar after its own goal and percentage", async ({
  page,
}, testInfo) => {
  // Both shapes stay mounted at every width and CSS displays one of them, so the
  // accessibility tree — which a role locator reads — carries only the shape this
  // project's viewport renders. The laptop's table adds the total's own bar.
  const desktop = testInfo.project.name === "desktop";

  await page.goto("/es/planning/goals");
  await expect(page.getByRole("progressbar")).toHaveCount(
    desktop ? SEED.length + 1 : SEED.length,
  );

  for (const goal of SEED) {
    await expect(
      page.getByRole("progressbar", { name: progressName(goal.name, pctOf(goal)) }),
    ).toHaveCount(1);
  }
});

test("paints the bar of a goal behind its straight line amber", async ({
  page,
}) => {
  const behind = SEED[4];
  const onTrack = SEED[1];

  await page.goto("/es/planning/goals");

  // The colour of the bar is the band both shapes carry: the ritmo badge beside
  // it is the dense table's alone, and the card has only this.
  await expect(
    page.getByRole("progressbar", { name: progressName(behind.name, pctOf(behind)) }),
  ).toHaveAttribute("data-accent-color", "amber");
  // A goal opened today has spent none of its span, so nothing it is due in 90
  // days can put it behind — the band is the pace's, not every unfinished goal's.
  await expect(
    page.getByRole("progressbar", {
      name: progressName(onTrack.name, pctOf(onTrack)),
    }),
  ).not.toHaveAttribute("data-accent-color", "amber");
});

test.describe("the laptop table", () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 1280,
    "the total row and the ritmo column are the dense table's, which renders from lg up",
  );

  test("reads the goal opened in the past as atrasada, and lists it first", async ({
    page,
  }) => {
    const behind = SEED[4];
    const onTrack = SEED[1];

    await page.goto("/es/planning/goals");

    const rows = page.getByRole("table", { name: goals.title }).getByRole("row");
    // The rows arrive ordered by ritmo out of Postgres, atrasada first, so the
    // band and the place it holds are one claim (RF-87, RNF-07).
    const first = rows.nth(1);
    await expect(first).toContainText(behind.name);
    await expect(first.getByText(goals.paceBehind, { exact: true })).toBeVisible();

    await expect(
      rows
        .filter({ hasText: onTrack.name })
        .getByText(goals.paceOnTrack, { exact: true }),
    ).toBeVisible();
  });

  test("totals the apartado of the rows it is showing", async ({ page }) => {
    await page.goto("/es/planning/goals");

    const rows = page.getByRole("table", { name: goals.title }).getByRole("row");
    // The header, one row per seeded goal, and the total.
    await expect(rows).toHaveCount(SEED.length + 2);

    let sumPesos = 0;
    for (let index = 1; index <= SEED.length; index++) {
      sumPesos += await pesosOf(rows.nth(index));
    }

    expect(await pesosOf(rows.last())).toBe(sumPesos);
    // And the figure being summed is the one the aportes add up to in Postgres,
    // not merely one the screen agrees with itself about (RF-87, RNF-07).
    expect(sumPesos * 100).toBe(SEED.reduce((sum, goal) => sum + savedOf(goal), 0));
  });
});

test("removes the aporte a person picks and leaves the goal beside it alone", async ({
  page,
}) => {
  const target = SEED[0];
  const neighbour = SEED[1];
  // Deliberately not the most recent: the undo list runs newest first, so the
  // oldest aporte is its last entry, and undoing "the last one" on the person's
  // behalf would take a different row than the one they clicked.
  const removedCents = target.contributions[2].amountCents;

  await page.goto("/es/planning/goals");

  await page
    .getByRole("button", {
      name: common.actionsFor.replace("{name}", target.name),
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: goals.undoContribution, exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  const entries = dialog.getByRole("button", { name: removeName() });
  await expect(entries).toHaveCount(target.contributions.length);

  await entries.last().click();
  await expect(entries).toHaveCount(target.contributions.length - 1);

  // The cents behind the screen: the goal's own aportes are short exactly the one
  // that was removed, and the row that was never touched still sums to itself.
  expect(await savedCents(goalIds.get(target.key)!)).toBe(
    savedOf(target) - removedCents,
  );
  expect(await savedCents(goalIds.get(neighbour.key)!)).toBe(savedOf(neighbour));

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // And the bar re-derives from what is left, in both shapes (RNF-07).
  const remainingPct = Math.min(
    Math.round(((savedOf(target) - removedCents) * 100) / target.targetCents),
    100,
  );
  await expect(
    page.getByRole("progressbar", { name: progressName(target.name, remainingPct) }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", {
      name: progressName(neighbour.name, pctOf(neighbour)),
    }),
  ).toBeVisible();
});

// The bar's accessible name with the formatted amount left open: what this
// asserts is the goal it belongs to and the percentage it stands at.
function progressName(name: string, pct: number): RegExp {
  const [head, tail] = goals.progressLabel
    .replace("{name}", name)
    .replace("{pct}", String(pct))
    .split("{amount}");

  return new RegExp(`^${escapeRegExp(head)}.+${escapeRegExp(tail)}$`);
}

// Every entry of the undo list, whatever amount and date each one names.
function removeName(): RegExp {
  return new RegExp(`^${escapeRegExp(goals.removeContribution.split("{")[0])}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The apartado a row is showing, in whole pesos: COP rounds to the peso, so the
// digits of the figure are the cents behind it divided by a hundred.
async function pesosOf(row: Locator): Promise<number> {
  const text = (await row.getByRole("cell").nth(3).textContent()) ?? "";

  return Number(text.replace(/\D/g, ""));
}

// What the goal has set aside, summed from the aportes its progress derives from
// (RF-87), in the integer cents they are stored as.
async function savedCents(goalId: string): Promise<number> {
  const [row] = await fixtureSql<{ saved: string }[]>`
    select coalesce(sum(amount_cents), 0)::text as saved
    from goal_contributions where goal_id = ${goalId}`;

  return Number(row.saved);
}
