import type { CurrencyCode } from "@/lib/currency";
import type { MEMBER_DEBT_KINDS } from "@/lib/validation/member-debt";

export type MemberDebtEntry = {
  id: string;
  kind: (typeof MEMBER_DEBT_KINDS)[number];
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

export type MemberDebtStatus = "pending" | "partial" | "settled";

export type MemberDebtState = {
  status: MemberDebtStatus;
  paidCents: number;
  remainingCents: number;
  // The day the payment that brought the debt to zero was made; null until it is settled.
  settledOn: string | null;
};

/**
 * Where each debt stands (RF-205), derived from the entries and never stored. A payment is not tied to one debt:
 * the payments of a debtor to a creditor in a currency pay that direction's debts oldest first. A debt the other
 * direction owes plays no part. `entries` come newest first, as `getMemberDebts` reads them.
 */
export function memberDebtStates(entries: MemberDebtEntry[]): Map<string, MemberDebtState> {
  const groups = new Map<string, { debts: MemberDebtEntry[]; payments: MemberDebtEntry[] }>();
  for (const entry of [...entries].reverse()) {
    const key = `${entry.debtorMemberId}:${entry.creditorMemberId}:${entry.currency}`;
    const group = groups.get(key) ?? { debts: [], payments: [] };
    group[entry.kind === "debt" ? "debts" : "payments"].push(entry);
    groups.set(key, group);
  }

  const states = new Map<string, MemberDebtState>();
  for (const { debts, payments } of groups.values()) {
    const totalPaid = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    let before = 0;
    for (const debt of debts) {
      const paidCents = Math.min(Math.max(totalPaid - before, 0), debt.amountCents);
      const settled = paidCents === debt.amountCents;
      let settledOn: string | null = null;
      if (settled) {
        const target = before + debt.amountCents;
        let running = 0;
        const closing = payments.find((payment) => (running += payment.amountCents) >= target);
        settledOn = closing && closing.occurredOn > debt.occurredOn ? closing.occurredOn : debt.occurredOn;
      }
      states.set(debt.id, {
        status: settled ? "settled" : paidCents > 0 ? "partial" : "pending",
        paidCents,
        remainingCents: debt.amountCents - paidCents,
        settledOn,
      });
      before += debt.amountCents;
    }
  }
  return states;
}

/** The debts a payment settled: those settled with it among the entries and not without it. */
export function debtsSettledBy(entries: MemberDebtEntry[], paymentId: string): MemberDebtEntry[] {
  const before = memberDebtStates(entries.filter((entry) => entry.id !== paymentId));
  const after = memberDebtStates(entries);
  return entries.filter((entry) => after.get(entry.id)?.status === "settled" && before.get(entry.id)?.status !== "settled");
}
