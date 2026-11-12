import "server-only";

import { sql } from "drizzle-orm";

import { insertAccount } from "@/db/queries/accounts";
import { bookMovement } from "@/db/queries/ledger-write";
import { withUserDb } from "@/db/session";
import type { CurrencyCode } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { creditHistory, monthOf, type CreditMonth } from "@/lib/third-party-credit";
import { createTransactionSchema } from "@/lib/validation/transaction";
import type {
  RecordThirdPartyPaymentInput,
  SetUpThirdPartyCreditInput,
  UpdateThirdPartyCreditInput,
} from "@/lib/validation/third-party-credit";

// A credit in the person's name that somebody else pays, read whole (RF-212): what the credit still owes, what
// the payer still owes the person and has paid, and each month's two transfers. Every figure derives from
// movements; only the link, the payer's name and the lender's terms are stored.
export type ThirdPartyCreditView = {
  id: string;
  liabilityAccountId: string;
  liabilityName: string;
  receivableAccountId: string;
  receivableName: string;
  personName: string;
  currency: string;
  installmentCents: number | null;
  dueDay: number | null;
  // What the credit still owes: zero once it is paid or in credit.
  owedCents: number;
  // What the payer still owes the person: the receivable's balance, below zero when they paid ahead.
  personOwesCents: number;
  // Everything the payer has sent, from the day the receivable opened.
  personPaidCents: number;
  // The current month first, one line per month since the first trace.
  months: CreditMonth[];
  canWrite: boolean;
};

type RawMonth = { month: string; paid: string; paidOn: string | null; lender: string; lenderOn: string | null };

type RawCredit = Omit<
  ThirdPartyCreditView,
  "installmentCents" | "owedCents" | "personOwesCents" | "personPaidCents" | "months"
> & {
  installmentCents: string | null;
  openedOn: string;
  liabilityBalance: string;
  receivableBalance: string;
  paidTotal: string;
  rows: RawMonth[];
};

/**
 * The credits somebody else pays that the caller may read — one, when `liabilityAccountId` names it — in ONE
 * statement: the link, both balances from `account_balances`, and the transfers grouped by month. A transfer
 * out of the receivable is the payer's money arriving; a transfer into the liability is the installment going
 * to the lender. The policies scope every table the statement touches.
 */
export async function listThirdPartyCredits(liabilityAccountId?: string): Promise<ThirdPartyCreditView[]> {
  const currentMonth = monthOf(todayInBogota());
  const rows = await withUserDb((tx) =>
    tx.execute<RawCredit>(sql`
      select c.id, c.liability_account_id as "liabilityAccountId", l.name as "liabilityName",
        c.receivable_account_id as "receivableAccountId", r.name as "receivableName",
        c.person_name as "personName", l.settlement_currency as currency,
        c.installment_cents::text as "installmentCents", c.due_day as "dueDay",
        r.initial_balance_on::text as "openedOn",
        coalesce(lb.balance_cents, 0)::text as "liabilityBalance",
        coalesce(rb.balance_cents, 0)::text as "receivableBalance",
        private.can_write_account(c.liability_account_id) as "canWrite",
        coalesce((select sum(t.amount_cents) from transactions t
          where t.from_account_id = c.receivable_account_id and t.to_account_id is not null
            and t.currency = l.settlement_currency), 0)::text as "paidTotal",
        coalesce((select json_agg(m) from (
          select to_char(t.occurred_at, 'YYYY-MM') as month,
            coalesce(sum(t.amount_cents) filter (where t.from_account_id = c.receivable_account_id), 0)::text as paid,
            (max(t.occurred_at) filter (where t.from_account_id = c.receivable_account_id))::text as "paidOn",
            coalesce(sum(t.amount_cents) filter (where t.to_account_id = c.liability_account_id), 0)::text as lender,
            (max(t.occurred_at) filter (where t.to_account_id = c.liability_account_id))::text as "lenderOn"
          from transactions t
          where t.from_account_id is not null and t.to_account_id is not null
            and t.currency = l.settlement_currency
            and (t.from_account_id = c.receivable_account_id or t.to_account_id = c.liability_account_id)
          group by 1) m), '[]') as rows
      from third_party_credits c
      join accounts l on l.id = c.liability_account_id
      join accounts r on r.id = c.receivable_account_id
      left join account_balances lb on lb.id = l.id and lb.currency = l.settlement_currency
      left join account_balances rb on rb.id = r.id and rb.currency = r.settlement_currency
      where ${liabilityAccountId ?? null}::uuid is null or c.liability_account_id = ${liabilityAccountId ?? null}::uuid
      order by c.person_name, c.created_at`),
  );

  return rows.map((row) => {
    const { openedOn, liabilityBalance, receivableBalance, paidTotal, rows: monthRows, ...rest } = row;
    return {
      ...rest,
      installmentCents: row.installmentCents === null ? null : Number(row.installmentCents),
      owedCents: Math.max(0, -Number(liabilityBalance)),
      personOwesCents: Number(receivableBalance),
      personPaidCents: Number(paidTotal),
      months: creditHistory(
        monthRows.map((m) => ({
          month: m.month,
          paidCents: Number(m.paid),
          paidOn: m.paidOn,
          lenderCents: Number(m.lender),
          lenderOn: m.lenderOn,
        })),
        monthOf(openedOn),
        currentMonth,
      ),
    };
  });
}

/** What a credit the caller may read still owes, in its settlement currency; null when it is not a visible liability. */
export async function readCreditOwedCents(liabilityAccountId: string): Promise<number | null> {
  const [row] = await withUserDb((tx) =>
    tx.execute<{ balance: string }>(sql`
      select coalesce(b.balance_cents, 0)::text as balance
      from accounts a left join account_balances b on b.id = a.id and b.currency = a.settlement_currency
      where a.id = ${liabilityAccountId}::uuid and a.kind = 'liability'`),
  );
  return row ? Math.max(0, -Number(row.balance)) : null;
}

// The refusals the link's own constraints raise, said once for every door.
function mapLinkError(error: unknown): never {
  const constraint = pgConstraintName(error);
  if (constraint === "third_party_credits_liability_unique") throw new ActionError("thirdPartyCredit.errors.alreadyLinked");
  if (constraint === "third_party_credits_receivable_unique") throw new ActionError("thirdPartyCredit.errors.receivableTaken");
  const code = pgErrorCode(error);
  // TP001: the two accounts do not share scope and currency, or are not a liability and an asset.
  if (code === "TP001") throw new ActionError("thirdPartyCredit.errors.receivableInvalid");
  if (code === "42501") throw new ActionError("errors.notFound");
  throw error;
}

/**
 * «Lo paga otra persona» (RF-211): links the credit to a «Me debe» asset, in ONE transaction. With no
 * `receivableAccountId` it opens that asset in the credit's own scope and currency at `openingCents` as of
 * `openedOn`, and a refusal of the link takes the account back with it.
 */
export async function setUpThirdPartyCredit(
  input: SetUpThirdPartyCreditInput,
  receivableName: string,
): Promise<{ id: string; receivableAccountId: string }> {
  try {
    return await withUserDb(async (tx) => {
      const [credit] = await tx.execute<{ ownerUserId: string | null; groupId: string | null; isShared: boolean; currency: string }>(sql`
        select owner_user_id as "ownerUserId", group_id as "groupId", is_shared as "isShared", settlement_currency as currency
        from accounts
        where id = ${input.liabilityAccountId}::uuid and kind = 'liability' and private.can_write_account(id)`);
      if (!credit) throw new ActionError("errors.notFound");

      const receivableAccountId =
        input.receivableAccountId ??
        (
          await insertAccount(tx, {
            name: receivableName.slice(0, 80),
            kind: "asset",
            subtype: "bank",
            ownerUserId: credit.ownerUserId,
            groupId: credit.groupId,
            isShared: credit.isShared,
            institution: null,
            settlementCurrency: credit.currency as CurrencyCode,
            amountMinor: input.openingCents,
            balanceOn: input.openedOn,
          })
        ).accountId;

      const [link] = await tx.execute<{ id: string }>(sql`
        insert into third_party_credits (liability_account_id, receivable_account_id, person_name, installment_cents, due_day)
        values (${input.liabilityAccountId}::uuid, ${receivableAccountId}::uuid, ${input.personName},
          ${input.installmentCents}::bigint, ${input.dueDay}::smallint)
        returning id`);
      return { id: link.id, receivableAccountId };
    });
  } catch (error) {
    return mapLinkError(error);
  }
}

/** Renames the payer and sets what the lender asks (RF-211); the two accounts stay as linked. */
export async function updateThirdPartyCredit(input: UpdateThirdPartyCreditInput): Promise<void> {
  const rows = await withUserDb((tx) =>
    tx.execute<{ id: string }>(sql`
      update third_party_credits
         set person_name = ${input.personName}, installment_cents = ${input.installmentCents}::bigint, due_day = ${input.dueDay}::smallint
       where liability_account_id = ${input.liabilityAccountId}::uuid
      returning id`),
  );
  if (rows.length === 0) throw new ActionError("errors.notFound");
}

/** Stops following the credit as paid by somebody else. Both accounts and every movement stay (RF-211). */
export async function removeThirdPartyCredit(liabilityAccountId: string): Promise<void> {
  const rows = await withUserDb((tx) =>
    tx.execute<{ id: string }>(sql`delete from third_party_credits where liability_account_id = ${liabilityAccountId}::uuid returning id`),
  );
  if (rows.length === 0) throw new ActionError("errors.notFound");
}

/**
 * The payer's money arriving (RF-213): one TRANSFER from the credit's receivable to `toAccountId`, never an
 * income. It is booked by the same write as the movement form, so the form's schema judges it again and a
 * movement dated before an account's opening is refused as it is anywhere else.
 */
export async function recordThirdPartyPayment(
  input: RecordThirdPartyPaymentInput,
  describe: (person: string) => string,
): Promise<{ transactionId: string }> {
  const [link] = await withUserDb((tx) =>
    tx.execute<{ receivableAccountId: string; personName: string }>(sql`
      select receivable_account_id as "receivableAccountId", person_name as "personName" from third_party_credits
      where liability_account_id = ${input.liabilityAccountId}::uuid`),
  );
  if (!link) throw new ActionError("errors.notFound");
  if (link.receivableAccountId === input.toAccountId) throw new ActionError("thirdPartyCredit.errors.sameAccount");

  const movement = createTransactionSchema.safeParse({
    fromAccountId: link.receivableAccountId,
    toAccountId: input.toAccountId,
    amount: input.amount,
    occurredAt: input.occurredAt,
    description: describe(link.personName),
    splits: [],
    labelIds: [],
    requestRef: input.requestRef,
  });
  if (!movement.success) throw new ActionError(movement.error.issues[0].message);
  return bookMovement(movement.data);
}
