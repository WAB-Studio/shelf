import "server-only";

import type { CurrencyCode } from "@/lib/currency";

export type OwnerNetWorth = {
  bucket: "member" | "group";
  ownerUserId: string | null;
  groupId: string | null;
  // The one currency this figure counts, and it is never added to another
  // (RF-124). An owner holding two currencies answers twice.
  currency: CurrencyCode;
  netWorthCents: number;
};

// One pocket of one account, as `getAccountBalances` hands it over.
type AccountPocket = {
  accountId: string;
  currency: CurrencyCode;
  balanceCents: number;
};

/**
 * Net worth per owner AND currency, folded from the already-fanned `listAccounts`
 * and `getAccountBalances` outputs — a PURE reducer, no round trip of its own
 * (RF-88, RNF-09). A personal account sums into its member's buckets, a group
 * account into the group's, and the group's accounts are never split across
 * people (RF-67). Each balance is derived from movements upstream (RNF-07), and a
 * liability's is already negative, so this signed sum IS net worth with no
 * per-kind branch (RNF-05).
 *
 * The key is the pair (owner, currency) because `account_balances` answers one
 * row per account AND currency: keyed by the account alone, a card that bills in
 * pesos and buys in dollars keeps whichever pocket was read last and reports it
 * as the whole account.
 */
export function netWorthByOwner(
  accounts: { id: string; ownerUserId: string | null; groupId: string | null }[],
  balances: AccountPocket[],
): OwnerNetWorth[] {
  const pocketsByAccount = new Map<string, AccountPocket[]>();
  for (const balance of balances) {
    const pockets = pocketsByAccount.get(balance.accountId);
    if (pockets) pockets.push(balance);
    else pocketsByAccount.set(balance.accountId, [balance]);
  }

  const buckets = new Map<string, OwnerNetWorth>();
  for (const account of accounts) {
    // The owner-XOR-group check pins each account to exactly one owner; an
    // account naming neither belongs nowhere and is skipped.
    let ownerKey: string;
    let owner: Omit<OwnerNetWorth, "currency" | "netWorthCents">;
    if (account.ownerUserId !== null) {
      ownerKey = `member:${account.ownerUserId}`;
      owner = { bucket: "member", ownerUserId: account.ownerUserId, groupId: null };
    } else if (account.groupId !== null) {
      ownerKey = `group:${account.groupId}`;
      owner = { bucket: "group", ownerUserId: null, groupId: account.groupId };
    } else {
      continue;
    }

    for (const pocket of pocketsByAccount.get(account.id) ?? []) {
      const key = `${ownerKey}|${pocket.currency}`;
      const existing =
        buckets.get(key) ?? { ...owner, currency: pocket.currency, netWorthCents: 0 };

      existing.netWorthCents += pocket.balanceCents;
      buckets.set(key, existing);
    }
  }

  return [...buckets.values()];
}
