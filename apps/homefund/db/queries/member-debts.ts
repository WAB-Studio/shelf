import "server-only";

import { sql } from "drizzle-orm";

import { callerGroupId } from "@/db/queries/groups";
import { listCallerMembers } from "@/db/queries/group-members";
import { requireUser, withUserDb, type Transaction } from "@/db/session";
import { pgConstraintName, pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { memberDebtBalances, type MemberDebtBalance, type MemberDebtEntry } from "@/lib/member-debts";
import type { RecordMemberDebtInput } from "@/lib/validation/member-debt";

export type MemberDebtsData = {
  members: { id: string; name: string }[];
  balances: MemberDebtBalance[];
  entries: MemberDebtEntry[];
};

const MEMBER_REFERENCES = new Set(["member_debts_debtor_in_fund_fk", "member_debts_creditor_in_fund_fk"]);

type RawEntry = Omit<MemberDebtEntry, "amountCents"> & { amountCents: string };

// The fund's entries, newest first, each with both members' names (an archived member keeps theirs).
async function readEntries(tx: Transaction, userId: string): Promise<MemberDebtEntry[]> {
  const rows = await tx.execute<RawEntry>(sql`
    select d.id, d.kind, d.debtor_member_id as "debtorMemberId", dm.name as "debtorName",
      d.creditor_member_id as "creditorMemberId", cm.name as "creditorName", d.amount_cents::text as "amountCents",
      d.currency, d.occurred_on::text as "occurredOn", d.description
    from member_debts d
    join group_members dm on dm.id = d.debtor_member_id
    join group_members cm on cm.id = d.creditor_member_id
    where d.group_id = ${callerGroupId(userId)}
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

// What `debtor` still owes `creditor` in `currency` within fund `g.id`: debts from debtor to creditor and
// payments back count for it, the reverse ones against it, as `memberDebtBalances` nets them.
function pendingSql(debtor: string, creditor: string, currency: string) {
  return sql`(select coalesce(sum(case
      when d.debtor_member_id = ${debtor} and d.creditor_member_id = ${creditor} then 1
      when d.debtor_member_id = ${creditor} and d.creditor_member_id = ${debtor} then -1
      else 0 end * case d.kind when 'debt' then d.amount_cents else -d.amount_cents end), 0)
    from member_debts d where d.group_id = g.id and d.currency = ${currency})`;
}

/**
 * Writes one entry in the caller's fund. A payment larger than what the debtor still owes that creditor in
 * that currency is refused, under a lock on the fund so two payments cannot both pass; a member outside the
 * fund is refused by the references themselves.
 */
export async function recordMemberDebt(input: RecordMemberDebtInput): Promise<{ id: string }> {
  const user = await requireUser();
  const group = callerGroupId(user.id);
  try {
    return await withUserDb(async (tx) => {
      if (input.kind === "payment") {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('member_debts:' || coalesce(${group}::text, ''), 0))`);
      }
      const [row] = await tx.execute<{ groupId: string | null; id: string | null }>(sql`
        with g as (select ${group} as id),
        written as (
          insert into member_debts (group_id, kind, debtor_member_id, creditor_member_id, amount_cents, currency, occurred_on, description)
          select g.id, ${input.kind}, ${input.debtorMemberId}, ${input.creditorMemberId}, ${input.amountCents}, ${input.currency},
            ${input.occurredOn}, ${input.description}
          from g
          where g.id is not null
            and (${input.kind} = 'debt' or ${input.amountCents} <= ${pendingSql(input.debtorMemberId, input.creditorMemberId, input.currency)})
          returning id)
        select (select id from g) as "groupId", (select id from written) as id`);
      if (!row?.groupId) throw new ActionError("memberDebts.errors.noFund");
      if (!row.id) throw new ActionError("memberDebts.errors.overpaid");
      return { id: row.id };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23503" && MEMBER_REFERENCES.has(pgConstraintName(error) ?? "")) {
      throw new ActionError("memberDebts.errors.memberNotInFund");
    }
    throw error;
  }
}
