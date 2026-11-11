import type { CurrencyCode } from "@/lib/currency";

export type MemberDebtEntry = {
  id: string;
  kind: "debt" | "payment";
  debtorMemberId: string;
  debtorName: string;
  creditorMemberId: string;
  creditorName: string;
  amountCents: number;
  currency: CurrencyCode;
  occurredOn: string;
  description: string | null;
};

export type MemberDebtBalance = {
  debtorMemberId: string;
  debtorName: string;
  creditorMemberId: string;
  creditorName: string;
  currency: CurrencyCode;
  pendingCents: number;
};

/**
 * What each pair of members still owes, per currency (RF-183), summed from the entries and never
 * stored. A debt runs from debtor to creditor and a payment back, so one pair nets both ways: when
 * Adrian owes Papá 50 and Papá owes Adrian 200, Papá owes Adrian 150. A settled pair is left out.
 */
export function memberDebtBalances(entries: MemberDebtEntry[]): MemberDebtBalance[] {
  const pairs = new Map<string, { low: [string, string]; high: [string, string]; currency: CurrencyCode; net: number }>();
  for (const entry of entries) {
    const debtor: [string, string] = [entry.debtorMemberId, entry.debtorName];
    const creditor: [string, string] = [entry.creditorMemberId, entry.creditorName];
    const [low, high] = debtor[0] < creditor[0] ? [debtor, creditor] : [creditor, debtor];
    const key = `${low[0]}:${high[0]}:${entry.currency}`;
    const pair = pairs.get(key) ?? { low, high, currency: entry.currency, net: 0 };
    // Positive: the lower id owes the higher one.
    const owed = entry.kind === "debt" ? entry.amountCents : -entry.amountCents;
    pair.net += debtor === low ? owed : -owed;
    pairs.set(key, pair);
  }

  return [...pairs.values()]
    .filter((pair) => pair.net !== 0)
    .map(({ low, high, currency, net }) => {
      const [debtor, creditor] = net > 0 ? [low, high] : [high, low];
      return {
        debtorMemberId: debtor[0],
        debtorName: debtor[1],
        creditorMemberId: creditor[0],
        creditorName: creditor[1],
        currency,
        pendingCents: Math.abs(net),
      };
    })
    .sort((a, b) => b.pendingCents - a.pendingCents || a.debtorName.localeCompare(b.debtorName));
}

/** What `debtorMemberId` still owes `creditorMemberId` in `currency`; zero when nothing, or the other way round. */
export function pendingBetween(
  balances: MemberDebtBalance[],
  debtorMemberId: string,
  creditorMemberId: string,
  currency: CurrencyCode,
): number {
  return (
    balances.find(
      (b) => b.debtorMemberId === debtorMemberId && b.creditorMemberId === creditorMemberId && b.currency === currency,
    )?.pendingCents ?? 0
  );
}
