import "server-only";

import { sql } from "drizzle-orm";

import { callerGroupId } from "@/db/queries/groups";
import { listCallerMembers } from "@/db/queries/group-members";
import { requireUser, withUserDb, type Transaction } from "@/db/session";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { memberDebtBalances, pendingBetween, type MemberDebtBalance, type MemberDebtEntry } from "@/lib/member-debts";
import type { RecordMemberDebtInput } from "@/lib/validation/member-debt";

export type MemberDebtsData = {
  members: { id: string; name: string }[];
  balances: MemberDebtBalance[];
  entries: MemberDebtEntry[];
};

type RawEntry = Omit<MemberDebtEntry, "amountCents"> & { amountCents: string };

// The fund's entries, newest first, each with both members' names (an archived member keeps theirs).
async function readEntries(tx: Transaction, userId: string, pair?: { a: string; b: string; currency: string }): Promise<MemberDebtEntry[]> {
  const rows = await tx.execute<RawEntry>(sql`
    select d.id, d.kind, d.debtor_member_id as "debtorMemberId", dm.name as "debtorName",
      d.creditor_member_id as "creditorMemberId", cm.name as "creditorName", d.amount_cents::text as "amountCents",
      d.currency, d.occurred_on::text as "occurredOn", d.description
    from member_debts d
    join group_members dm on dm.id = d.debtor_member_id
    join group_members cm on cm.id = d.creditor_member_id
    where d.group_id = ${callerGroupId(userId)}
      ${pair ? sql`and d.currency = ${pair.currency} and ${pair.a} in (d.debtor_member_id, d.creditor_member_id) and ${pair.b} in (d.debtor_member_id, d.creditor_member_id)` : sql``}
    order by d.occurred_on desc, d.created_at desc`);
  return rows.map((row) => ({ ...row, amountCents: Number(row.amountCents) }));
}

/** RF-183: the caller's fund's live members, every entry between them and what each pair still owes. Null outside a fund. */
export async function getMemberDebts(): Promise<MemberDebtsData | null> {
  const user = await requireUser();
  return withUserDb(async (tx) => {
    const [members, entries] = await Promise.all([listCallerMembers(user.id, { archived: false }, tx), readEntries(tx, user.id)]);
    if (members.length === 0) return null;
    return {
      members: members.map((member) => ({ id: member.id, name: member.name })),
      balances: memberDebtBalances(entries),
      entries,
    };
  });
}

/**
 * Writes one entry in the caller's fund. A payment larger than what the debtor still owes that creditor in
 * that currency is refused; a member outside the fund is refused by the references themselves (23503).
 */
export async function recordMemberDebt(input: RecordMemberDebtInput): Promise<{ id: string }> {
  const user = await requireUser();
  try {
    return await withUserDb(async (tx) => {
      if (input.kind === "payment") {
        const pairEntries = await readEntries(tx, user.id, { a: input.debtorMemberId, b: input.creditorMemberId, currency: input.currency });
        const owed = pendingBetween(memberDebtBalances(pairEntries), input.debtorMemberId, input.creditorMemberId, input.currency);
        if (input.amountCents > owed) throw new ActionError("memberDebts.errors.overpaid");
      }
      const [row] = await tx.execute<{ id: string }>(sql`
        insert into member_debts (group_id, kind, debtor_member_id, creditor_member_id, amount_cents, currency, occurred_on, description)
        select g.id, ${input.kind}, ${input.debtorMemberId}, ${input.creditorMemberId}, ${input.amountCents}, ${input.currency},
          ${input.occurredOn}, ${input.description}
        from (select ${callerGroupId(user.id)} as id) g
        where g.id is not null
        returning id`);
      if (!row) throw new ActionError("memberDebts.errors.noFund");
      return row;
    });
  } catch (error) {
    if (pgErrorCode(error) === "23503") throw new ActionError("memberDebts.errors.memberNotInFund");
    throw error;
  }
}

/** Removes one entry of the caller's fund; false when there was none the caller may remove. */
export async function deleteMemberDebt(id: string): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`delete from member_debts where id = ${id} returning id`);
    return rows.length > 0;
  });
}
