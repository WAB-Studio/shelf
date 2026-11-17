import "server-only";

import { sql } from "drizzle-orm";

import { listCardDeferrals, upsertCardDeferrals } from "@/db/queries/card-deferrals";
import type { CardDeferralRow } from "@/db/queries/card-deferrals";
import { getDebtTerms } from "@/db/queries/debt-terms";
import { saveDebtTerms } from "@/db/queries/debt-write";
import { recordStatement } from "@/db/queries/statement-write";
import type { DebtTerms } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { chargesInterest, deferralCost } from "@/lib/card-deferral";
import { matchPurchases, purchaseWindow, type BookedPurchase } from "@/lib/card-purchases";
import { ActionError } from "@/lib/errors";
import { centsToDecimal } from "@/lib/money";
import type { RecordAccountStatementInput } from "@/lib/validation/account-statement";
import type { CardDeferralInput, CardPurchaseInput } from "@/lib/validation/card-statement";
import { debtTermsSchema, fractionToPercent, percentToFraction } from "@/lib/validation/debt-terms";
import type { DebtTermsInput } from "@/lib/validation/debt-terms";

// What a statement read off a card's PDF changes in HomeFund (RF-254): its terms, the closed statement, the
// deferrals it lists, and which of its purchases are not booked yet. Every part is planned first from what is
// stored, so a dry run and a real call answer the same plan, and only then written. The parts commit one after
// another, never as one transaction: a second call of the same input finds the first parts already done and
// finishes the rest, which is why each plans as «same» or «alreadyRecorded» the second time.

// The terms a statement prints, any of them absent: what is absent keeps what the card already has.
export type CardTermsPatch = {
  debtKind?: DebtTermsInput["debtKind"];
  annualRatePct?: string | null;
  creditLimitCents?: number | null;
  statementCutOffDay?: number | null;
  paymentDueDay?: number | null;
  minimumPaymentCents?: number | null;
  minimumPaymentPct?: string | null;
  avalCents?: number | null;
};

export type RecordCardStatementArgs = {
  accountId: string;
  dryRun: boolean;
  statement: RecordAccountStatementInput;
  terms: CardTermsPatch;
  deferrals: CardDeferralInput[];
  purchases: CardPurchaseInput[];
};

export type CardStatementPlan = {
  statement: { action: "recorded" | "alreadyRecorded"; cutOffDate: string };
  terms: { action: "created" | "updated" | "same" | "kept" | "none"; changes: string[] };
  deferrals: {
    authorizationNumber: string;
    action: "inserted" | "updated" | "same" | "stale";
    monthlyInterestCents: number;
    savingsCents: number;
    chargesInterest: boolean;
  }[];
  // Stored for this card but absent from this statement's list: paid off, or the PDF left it out.
  missingFromStatement: { authorizationNumber: string; description: string; pendingBalanceCents: number }[];
  purchases: { newCount: number; booked: { index: number; transactionId: string }[]; new: { index: number }[] };
};

type CardState = {
  kind: "asset" | "liability";
  canWrite: boolean;
};

// The card's kind and whether the caller may write it, read through the policies: an account they cannot see is one row short.
async function readCard(accountId: string): Promise<CardState | null> {
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ kind: "asset" | "liability"; can_write: boolean }>(sql`
      select a.kind, private.can_write_account(a.id) as can_write from accounts a where a.id = ${accountId}`);
    return row ? { kind: row.kind, canWrite: row.can_write } : null;
  });
}

async function readCutOffs(accountId: string): Promise<string[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ cut_off_date: string }>(sql`
      select cut_off_date::text from account_statements where account_id = ${accountId} order by cut_off_date desc`);
    return rows.map((row) => row.cut_off_date);
  });
}

// Every purchase booked on the card inside the window the statement's lines span, in the currency each was spent in.
async function readBooked(accountId: string, window: { from: string; to: string }): Promise<BookedPurchase[]> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ id: string; occurred_on: string; amount_cents: string; currency: string }>(sql`
      select t.id, t.occurred_at::text as occurred_on, t.amount_cents::text, t.currency
      from transactions t
      where t.from_account_id = ${accountId} and t.occurred_at between ${window.from}::date and ${window.to}::date`);
    return rows.map((row) => ({ id: row.id, occurredOn: row.occurred_on, amountCents: Number(row.amount_cents), currency: row.currency }));
  });
}

// The stored terms as the typed fields the terms schema reads, overlaid with what the statement printed.
function mergeTerms(existing: DebtTerms | null, patch: CardTermsPatch): unknown {
  const stored = existing
    ? {
        debtKind: existing.debtKind,
        annualRate: fractionToPercent(existing.annualRate),
        minimumPayment: existing.minimumPaymentCents === null ? null : centsToDecimal(existing.minimumPaymentCents),
        minimumPaymentPct: existing.minimumPaymentPct === null ? null : fractionToPercent(existing.minimumPaymentPct),
        creditLimit: existing.creditLimitCents === null ? null : centsToDecimal(existing.creditLimitCents),
        statementCutOffDay: existing.statementCutOffDay,
        paymentDueDay: existing.paymentDueDay,
        aval: existing.avalCents === null ? null : centsToDecimal(existing.avalCents),
      }
    : { debtKind: "revolving", annualRate: undefined };
  // A minimum is an amount or a percentage, never both: the one the statement printed replaces the other.
  const minimum =
    patch.minimumPaymentCents != null
      ? { minimumPayment: centsToDecimal(patch.minimumPaymentCents), minimumPaymentPct: null }
      : patch.minimumPaymentPct != null
        ? { minimumPayment: null, minimumPaymentPct: patch.minimumPaymentPct }
        : {};
  return {
    ...stored,
    ...(patch.debtKind ? { debtKind: patch.debtKind } : {}),
    ...(patch.annualRatePct != null ? { annualRate: patch.annualRatePct } : {}),
    ...(patch.creditLimitCents != null ? { creditLimit: centsToDecimal(patch.creditLimitCents) } : {}),
    ...(patch.statementCutOffDay != null ? { statementCutOffDay: patch.statementCutOffDay } : {}),
    ...(patch.paymentDueDay != null ? { paymentDueDay: patch.paymentDueDay } : {}),
    ...(patch.avalCents != null ? { aval: centsToDecimal(patch.avalCents) } : {}),
    ...minimum,
  };
}

// The names of the terms that differ from what is stored.
function termsChanges(existing: DebtTerms, next: DebtTermsInput): string[] {
  const minimumCents = next.minimumPayment == null ? null : Number(next.minimumPayment);
  const pairs: [string, boolean][] = [
    ["debtKind", existing.debtKind !== next.debtKind],
    ["annualRate", Number(existing.annualRate) !== Number(percentToFraction(next.annualRate))],
    ["minimumPayment", minimumCents !== (existing.minimumPaymentCents === null ? null : Number(centsToDecimal(existing.minimumPaymentCents)))],
    [
      "minimumPaymentPct",
      (next.minimumPaymentPct == null ? null : Number(percentToFraction(next.minimumPaymentPct))) !==
        (existing.minimumPaymentPct === null ? null : Number(existing.minimumPaymentPct)),
    ],
    [
      "creditLimit",
      (next.creditLimit == null ? null : Number(next.creditLimit)) !==
        (existing.creditLimitCents === null ? null : Number(centsToDecimal(existing.creditLimitCents))),
    ],
    ["statementCutOffDay", (next.statementCutOffDay ?? null) !== existing.statementCutOffDay],
    ["paymentDueDay", (next.paymentDueDay ?? null) !== existing.paymentDueDay],
    [
      "aval",
      (next.aval == null ? null : Number(next.aval)) !== (existing.avalCents === null ? null : Number(centsToDecimal(existing.avalCents))),
    ],
  ];
  return pairs.filter(([, differs]) => differs).map(([name]) => name);
}

function sameFigures(row: CardDeferralRow, incoming: CardDeferralInput): boolean {
  return (
    row.description === incoming.description &&
    row.currency === incoming.currency &&
    row.originalAmountCents === incoming.originalAmountCents &&
    row.instalments === incoming.instalments &&
    row.currentInstalment === incoming.currentInstalment &&
    row.monthlyInstalmentCents === incoming.monthlyInstalmentCents &&
    row.pendingBalanceCents === incoming.pendingBalanceCents &&
    Number(row.annualRate) === Number(percentToFraction(incoming.annualRatePct))
  );
}

/**
 * Plans, and unless `dryRun` writes, what one card statement changes (RF-254). The terms are overwritten only
 * by a statement no older than the latest one recorded, so an old PDF never undoes what a newer one set; the
 * deferrals are upserted by the bank's authorization number under the same rule; the statement is recorded
 * once per cut-off. The purchases are only compared with what is booked, never written.
 */
export async function recordCardStatement(args: RecordCardStatementArgs): Promise<CardStatementPlan & { dryRun: boolean }> {
  const { accountId, statement } = args;
  const window = purchaseWindow(args.purchases);
  const [card, existingTerms, cutOffs, stored, booked] = await Promise.all([
    readCard(accountId),
    getDebtTerms(accountId),
    readCutOffs(accountId),
    listCardDeferrals(accountId),
    window === null ? Promise.resolve([]) : readBooked(accountId, window),
  ]);
  if (card === null || !card.canWrite) throw new ActionError("errors.notFound");
  if (card.kind !== "liability") throw new ActionError("debts.errors.notLiability");

  // A statement is the newest when no recorded cut-off is later than it; an equal one is the same statement again.
  const newest = cutOffs.every((cutOff) => cutOff <= statement.cutOffDate);

  let termsPlan: CardStatementPlan["terms"] = { action: "none", changes: [] };
  let nextTerms: DebtTermsInput | null = null;
  const printed = Object.values(args.terms).some((value) => value != null);
  if (printed || existingTerms === null) {
    const verdict = debtTermsSchema.safeParse({ accountId, ...(mergeTerms(existingTerms, args.terms) as object) });
    if (!verdict.success) {
      const message = verdict.error.issues[0].message;
      // The rate is the one field a card cannot be opened without; its absence reads as «say the rate».
      throw new ActionError(existingTerms === null && args.terms.annualRatePct == null ? "cardStatement.errors.rateNeeded" : message);
    }
    nextTerms = verdict.data;
    if (existingTerms === null) termsPlan = { action: "created", changes: [] };
    else if (!newest) termsPlan = { action: "kept", changes: termsChanges(existingTerms, nextTerms) };
    else {
      const changes = termsChanges(existingTerms, nextTerms);
      termsPlan = { action: changes.length === 0 ? "same" : "updated", changes };
    }
  }

  const byNumber = new Map(stored.map((row) => [row.authorizationNumber, row]));
  const deferralPlan: CardStatementPlan["deferrals"] = args.deferrals.map((incoming) => {
    const figures = {
      originalAmountCents: incoming.originalAmountCents,
      instalments: incoming.instalments,
      pendingBalanceCents: incoming.pendingBalanceCents,
      annualRate: percentToFraction(incoming.annualRatePct),
    };
    const known = byNumber.get(incoming.authorizationNumber);
    const action = !known
      ? "inserted"
      : known.statementOn > statement.cutOffDate
        ? "stale"
        : sameFigures(known, incoming)
          ? "same"
          : "updated";
    const { monthlyInterestCents, savingsCents } = deferralCost(figures);
    return { authorizationNumber: incoming.authorizationNumber, action, monthlyInterestCents, savingsCents, chargesInterest: chargesInterest(figures) };
  });
  const listed = new Set(args.deferrals.map((incoming) => incoming.authorizationNumber));
  const missing = args.deferrals.length === 0 ? [] : stored.filter((row) => !listed.has(row.authorizationNumber));

  const matches = matchPurchases(args.purchases, booked);
  const plan: CardStatementPlan = {
    statement: {
      action: cutOffs.includes(statement.cutOffDate) ? "alreadyRecorded" : "recorded",
      cutOffDate: statement.cutOffDate,
    },
    terms: termsPlan,
    deferrals: deferralPlan,
    missingFromStatement: missing.map((row) => ({
      authorizationNumber: row.authorizationNumber,
      description: row.description,
      pendingBalanceCents: row.pendingBalanceCents,
    })),
    purchases: {
      newCount: matches.filter((match) => match === null).length,
      booked: matches.flatMap((match, index) => (match === null ? [] : [{ index, transactionId: match }])),
      new: matches.flatMap((match, index) => (match === null ? [{ index }] : [])),
    },
  };
  if (args.dryRun) return { ...plan, dryRun: true };

  if (plan.statement.action === "recorded") await recordStatement(statement);
  if (nextTerms !== null && (termsPlan.action === "created" || termsPlan.action === "updated")) {
    await saveDebtTerms(nextTerms, { replace: true });
  }
  const writes = args.deferrals.filter((incoming) => {
    const action = deferralPlan.find((row) => row.authorizationNumber === incoming.authorizationNumber)?.action;
    return action === "inserted" || action === "updated";
  });
  await upsertCardDeferrals(
    accountId,
    writes.map((incoming) => ({
      authorizationNumber: incoming.authorizationNumber,
      description: incoming.description,
      currency: incoming.currency,
      originalAmountCents: incoming.originalAmountCents,
      instalments: incoming.instalments,
      currentInstalment: incoming.currentInstalment,
      monthlyInstalmentCents: incoming.monthlyInstalmentCents,
      pendingBalanceCents: incoming.pendingBalanceCents,
      annualRate: percentToFraction(incoming.annualRatePct),
      statementOn: statement.cutOffDate,
    })),
  );
  return { ...plan, dryRun: false };
}
