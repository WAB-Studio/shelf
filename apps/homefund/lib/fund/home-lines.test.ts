import assert from "node:assert/strict";
import { test } from "node:test";

import { fixItems, pocketCover, summarizeAccounts, type HomeAccount } from "./home-lines";

function account(over: Partial<HomeAccount> & Pick<HomeAccount, "id" | "name">, cents: number): HomeAccount {
  return {
    kind: "asset",
    subtype: "bank",
    settlementCurrency: "COP",
    balances: [{ currency: "COP", balanceCents: cents }],
    ...over,
  };
}

const savings = account({ id: "a", name: "Ahorros" }, 905_100_000);
const pocket = account({ id: "p", name: "Emergencias", parentAccountId: "a" }, -15_000_000);
const cash = account({ id: "c", name: "Efectivo", subtype: "cash" }, 12_000_000);
const card = account({ id: "v", name: "Visa", kind: "liability", subtype: "card" }, -314_880_000);
const hidden = account({ id: "j", name: "Me debe John", subtype: "receivable", internal: true }, 474_000_000);

test("what a person has is the asset rows once, a pocket with its account, and net worth is the three figures", () => {
  const [cop] = summarizeAccounts([savings, pocket, cash, card, hidden]);

  assert.equal(cop.haveCents, 905_100_000 - 15_000_000 + 12_000_000);
  assert.equal(cop.owedToMeCents, 474_000_000);
  assert.equal(cop.owesCents, 314_880_000);
  assert.equal(cop.netCents, cop.haveCents + cop.owedToMeCents - cop.owesCents);
});

test("what friends owe for what was spent for them joins what is owed to the person and the net", () => {
  const [cop] = summarizeAccounts([savings, card, hidden], [{ currency: "COP", cents: 110_000_00 }]);

  assert.equal(cop.owedToMeCents, 474_000_000 + 110_000_00);
  assert.equal(cop.netCents, cop.haveCents + cop.owedToMeCents - cop.owesCents);
});

test("two currencies are two holdings, never one sum", () => {
  const dollars = account(
    { id: "d", name: "Dólares", settlementCurrency: "USD", balances: [{ currency: "USD", balanceCents: 5_000 }] },
    5_000,
  );
  const holdings = summarizeAccounts([savings, dollars]);

  assert.deepEqual(holdings.map((holding) => holding.currency), ["COP", "USD"]);
  assert.equal(holdings[1].haveCents, 5_000);
});

test("a pocket below zero names how much it spent beyond what it held and the account it lives in", () => {
  const items = fixItems({ accounts: [savings, pocket, cash], inboxCount: 0, shortLoans: [], staleCount: 0 });

  assert.deepEqual(items, [
    { kind: "pocket", pocketName: "Emergencias", parentName: "Ahorros", shortCents: 15_000_000, currency: "COP" },
  ]);
  assert.deepEqual(pocketCover({ balanceCents: -15_000_000, parentAccountId: "a" }), { parentId: "a", cents: 15_000_000 });
  assert.equal(pocketCover({ balanceCents: 0, parentAccountId: "a" }), null);
  assert.equal(pocketCover({ balanceCents: -1, parentAccountId: null }), null);
});

test("nothing odd leaves the list empty, and every kind that exists is listed once", () => {
  assert.deepEqual(fixItems({ accounts: [savings, cash, card], inboxCount: 0, shortLoans: [], staleCount: 0 }), []);

  const kinds = fixItems({
    accounts: [account({ id: "n", name: "Nequi" }, -1_600_000), pocket, savings],
    inboxCount: 2,
    shortLoans: [{ accountId: "l", name: "Lulo", currency: "COP", count: 2, shortCents: 761_200 }],
    staleCount: 3,
  }).map((item) => item.kind);

  assert.deepEqual(kinds, ["negative", "pocket", "inbox", "short", "reconcile"]);
});
