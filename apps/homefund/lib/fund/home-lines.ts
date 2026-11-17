// Pure reads behind Inicio's short lines and «Revisar el mes»: what a person has, what is odd and what is due.
// Every figure stays an integer number of cents and no line adds two currencies (RF-124).

type Balance = { currency: string; balanceCents: number };

// The slice of an account row these reads need, so this file imports nothing from the db layer.
export type HomeAccount = {
  id: string;
  name: string;
  kind: "asset" | "liability";
  subtype: string;
  parentAccountId?: string | null;
  settlementCurrency: string;
  balances: Balance[];
  internal?: boolean;
};

export type Holding = {
  currency: string;
  // What sits in the accounts, a pocket counted once with its account.
  haveCents: number;
  // What others owe: the receivable accounts the person lists, and what a credit somebody else pays and a friend «se le cobra» owe.
  owedToMeCents: number;
  // What is owed on cards and loans, as a positive figure.
  owesCents: number;
  // have + owedToMe - owes: the figure net worth reads.
  netCents: number;
};

/**
 * Per currency: the money in the accounts, what is owed to the person, what they owe and the net of the three.
 * Every row's `balances` is its own free part, so a pocket and its account add up once. `owedByPeople` is what the
 * people the person is owed by owe (RF-293): a credit's capital and what was spent for a friend. No account holds
 * either, so the hidden «Me debe» of a credit is left out and the figure comes from here (RF-301).
 */
export function summarizeAccounts(
  accounts: HomeAccount[],
  owedByPeople: { currency: string; cents: number }[] = [],
): Holding[] {
  const byCurrency = new Map<string, Holding>();
  const of = (currency: string): Holding => {
    const found = byCurrency.get(currency);
    if (found) return found;
    const fresh = { currency, haveCents: 0, owedToMeCents: 0, owesCents: 0, netCents: 0 };
    byCurrency.set(currency, fresh);
    return fresh;
  };

  for (const account of accounts) {
    if (account.internal) continue;
    for (const { currency, balanceCents } of account.balances) {
      const holding = of(currency);
      if (account.kind === "liability") holding.owesCents -= balanceCents;
      else if (account.subtype === "receivable") holding.owedToMeCents += balanceCents;
      else holding.haveCents += balanceCents;
      holding.netCents += balanceCents;
    }
  }

  for (const { currency, cents } of owedByPeople) {
    const holding = of(currency);
    holding.owedToMeCents += cents;
    holding.netCents += cents;
  }

  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export type FixItem =
  | { kind: "pocket"; pocketName: string; parentName: string | null; shortCents: number; currency: string }
  | { kind: "negative"; name: string; cents: number; currency: string }
  | { kind: "inbox"; count: number }
  | { kind: "short"; accountId: string; name: string; count: number; shortCents: number; currency: string }
  | { kind: "reconcile"; count: number };

export type ShortLoan = { accountId: string; name: string; currency: string; count: number; shortCents: number };

/**
 * What is odd right now, the same list Inicio's «Por arreglar» and «Revisar el mes» show: a pocket or an account below
 * zero, deliveries waiting in Bandeja, cuotas paid short and accounts not counted in a month. Empty when nothing is.
 */
export function fixItems(input: {
  accounts: HomeAccount[];
  inboxCount: number;
  shortLoans: ShortLoan[];
  staleCount: number;
}): FixItem[] {
  const names = new Map(input.accounts.map((account) => [account.id, account.name]));
  const items: FixItem[] = [];

  for (const account of input.accounts) {
    if (account.kind !== "asset" || account.internal || account.subtype === "receivable") continue;
    const own = account.balances.find((balance) => balance.currency === account.settlementCurrency);
    if (!own || own.balanceCents >= 0) continue;

    if (account.parentAccountId) {
      items.push({
        kind: "pocket",
        pocketName: account.name,
        parentName: names.get(account.parentAccountId) ?? null,
        shortCents: -own.balanceCents,
        currency: own.currency,
      });
    } else {
      items.push({ kind: "negative", name: account.name, cents: own.balanceCents, currency: own.currency });
    }
  }

  if (input.inboxCount > 0) items.push({ kind: "inbox", count: input.inboxCount });
  for (const loan of input.shortLoans) items.push({ kind: "short", ...loan });
  if (input.staleCount > 0) items.push({ kind: "reconcile", count: input.staleCount });

  return items;
}

/**
 * The pocket below zero a person can cover in one tap: the money the pocket spent beyond what it held, and the
 * account it lives in, which the transfer leaves. Null when the pocket is not below zero or has no account to give.
 */
export function pocketCover(
  pocket: { balanceCents: number; parentAccountId?: string | null },
): { parentId: string; cents: number } | null {
  if (pocket.balanceCents >= 0 || !pocket.parentAccountId) return null;
  return { parentId: pocket.parentAccountId, cents: -pocket.balanceCents };
}
