import "server-only";

import { eq } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { debtTerms } from "@/db/schema";
import type { DebtTerms } from "@/db/schema";
import { withUserDb } from "@/db/session";

// The debt profile of one liability account (RF-78), or null when it carries none.
// Scope is the policy's job: `withUserDb` shows only the caller's readable rows.
export async function getDebtTerms(accountId: string): Promise<DebtTerms | null> {
  return withUserDb(async (tx) => {
    const [row] = await tx
      .select()
      .from(debtTerms)
      .where(eq(debtTerms.accountId, accountId))
      .limit(1);

    return row ?? null;
  });
}

// The rate and the percentage are fractions, so they travel as decimal strings
// and cast to numeric in SQL; every cent field stays an integer. The minimum is
// a fixed amount XOR a percentage — the caller sets one and leaves the other null.
export type UpsertDebtTermsArgs = {
  accountId: string;
  debtKind: DebtTerms["debtKind"];
  annualRate: string;
  minimumPaymentCents: number | null;
  minimumPaymentPct: string | null;
  creditLimitCents: number | null;
  statementCutOffDay: number | null;
  paymentDueDay: number | null;
  avalCents: number | null;
};

// The single row per account: an insert the first time, an in-place rewrite after,
// pivoting on the primary-key conflict. The boolean-less return names the account
// the policy admitted.
export async function upsertDebtTerms(
  args: UpsertDebtTermsArgs,
): Promise<{ accountId: string }> {
  // A decimal string binds straight to a numeric column — the column type casts it.
  const writable = {
    debtKind: args.debtKind,
    annualRate: args.annualRate,
    minimumPaymentCents: args.minimumPaymentCents,
    minimumPaymentPct: args.minimumPaymentPct,
    creditLimitCents: args.creditLimitCents,
    statementCutOffDay: args.statementCutOffDay,
    paymentDueDay: args.paymentDueDay,
    avalCents: args.avalCents,
  };

  return withUserDb(async (tx) => {
    // `updated_at` is out of the SET: `debt_terms_set_timestamps` stamps it, no
    // UPDATE grant covers it, and the privilege check runs conflict or not.
    const [row] = await insertRow(
      tx,
      debtTerms,
      { accountId: args.accountId, ...writable },
      {
        onConflict: { target: debtTerms.accountId, set: writable },
        returning: { accountId: debtTerms.accountId },
      },
    );

    return { accountId: row.accountId };
  });
}

// The boolean reports whether the policy admitted the delete; the cascade removes
// nothing else — plans and statements sit on the account, not on its terms.
export async function deleteDebtTerms({
  accountId,
}: {
  accountId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(debtTerms)
      .where(eq(debtTerms.accountId, accountId))
      .returning({ accountId: debtTerms.accountId });

    return rows.length > 0;
  });
}
