import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { callerGroupId } from "@/db/queries/groups";
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

// The references that keep both members inside the entry's fund; a delete of a member named here is refused by them.
export const MEMBER_DEBT_REFERENCES = new Set(["member_debts_debtor_in_fund_fk", "member_debts_creditor_in_fund_fk"]);

type RawEntry = Omit<MemberDebtEntry, "amountCents"> & { amountCents: string };

/**
 * RF-183: the caller's fund's live members, every entry between them, newest first, and what each pair still
 * owes, in one statement. An archived member keeps their name on an entry. Null outside a fund.
 */
export async function getMemberDebts(): Promise<MemberDebtsData | null> {
  const user = await requireUser();
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ groupId: string | null; members: MemberDebtsData["members"]; entries: RawEntry[] }>(sql`
      with g as (select ${callerGroupId(user.id)} as id)
      select g.id as "groupId",
        coalesce((select json_agg(json_build_object('id', m.id, 'name', m.name) order by m.name)
          from group_members m where m.group_id = g.id and m.archived_at is null), '[]') as members,
        coalesce((select json_agg(json_build_object(
            'id', d.id, 'kind', d.kind, 'debtorMemberId', d.debtor_member_id, 'debtorName', dm.name,
            'creditorMemberId', d.creditor_member_id, 'creditorName', cm.name, 'amountCents', d.amount_cents::text,
            'currency', d.currency, 'occurredOn', d.occurred_on::text, 'description', d.description)
            order by d.occurred_on desc, d.created_at desc)
          from member_debts d
          join group_members dm on dm.id = d.debtor_member_id
          join group_members cm on cm.id = d.creditor_member_id
          where d.group_id = g.id), '[]') as entries
      from g`);
    if (!row?.groupId) return null;
    const entries = row.entries.map((entry) => ({ ...entry, amountCents: Number(entry.amountCents) }));
    return { members: row.members, balances: memberDebtBalances(entries), entries };
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

// Serialises the writes that read a pair's pending figure, per fund.
function lockFund(tx: Transaction, group: SQL) {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('member_debts:' || g.id::text, 0)) from (select ${group} as id) g where g.id is not null`);
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
        await lockFund(tx, group);
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
    if (pgErrorCode(error) === "23503" && MEMBER_DEBT_REFERENCES.has(pgConstraintName(error) ?? "")) {
      throw new ActionError("memberDebts.errors.memberNotInFund");
    }
    throw error;
  }
}

/**
 * Removes one entry of the caller's fund. A payment always goes; a debt goes only while the debtor's other debts
 * to that creditor in that currency still cover the payments the debtor made them, so no payment is left
 * standing on a debt that is gone.
 */
export async function deleteMemberDebt(id: string): Promise<"deleted" | "notFound" | "paid"> {
  const user = await requireUser();
  return withUserDb(async (tx) => {
    await lockFund(tx, callerGroupId(user.id));
    const [row] = await tx.execute<{ found: string | null; deleted: string | null }>(sql`
      with t as (select * from member_debts where id = ${id}),
      gone as (
        delete from member_debts d using t
        where d.id = t.id
          and (t.kind = 'payment' or (
            select coalesce(sum(case p.kind when 'debt' then p.amount_cents else -p.amount_cents end), 0)
            from member_debts p
            where p.group_id = t.group_id and p.currency = t.currency and p.id <> t.id
              and p.debtor_member_id = t.debtor_member_id and p.creditor_member_id = t.creditor_member_id) >= 0)
        returning d.id)
      select (select id from t) as found, (select id from gone) as deleted`);
    if (row?.deleted) return "deleted";
    return row?.found ? "paid" : "notFound";
  });
}
