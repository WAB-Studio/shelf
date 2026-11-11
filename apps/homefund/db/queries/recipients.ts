import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { accounts, categories, recipients } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { pgConstraintName } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import type { SaveRecipientInput } from "@/lib/validation/recipient";

export type RecipientRow = {
  id: string;
  identifier: string;
  name: string;
  kind: "own_account" | "person" | "payee";
  accountId: string | null;
  accountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

// The person's saved numbers, by name; the policy is the scope.
export async function listRecipients(): Promise<RecipientRow[]> {
  return withUserDb(async (tx) =>
    tx
      .select({
        id: recipients.id,
        identifier: recipients.identifier,
        name: recipients.name,
        kind: recipients.kind,
        accountId: recipients.accountId,
        accountName: accounts.name,
        categoryId: recipients.categoryId,
        categoryName: categories.name,
      })
      .from(recipients)
      .leftJoin(accounts, eq(accounts.id, recipients.accountId))
      .leftJoin(categories, eq(categories.id, recipients.categoryId))
      .orderBy(asc(recipients.name)),
  );
}

// Creates or updates in ONE statement. The account and the category must be readable by the caller: a
// foreign key alone would accept another person's id. No row back means one of them (or the recipient)
// is not theirs.
export async function saveRecipient(input: SaveRecipientInput): Promise<{ id: string }> {
  const references = sql`(${input.accountId}::uuid is null or exists (select 1 from accounts where id = ${input.accountId}::uuid))
    and (${input.categoryId}::uuid is null or exists (select 1 from categories where id = ${input.categoryId}::uuid))`;

  try {
    const [row] = await withUserDb(async (tx) =>
      input.id === null
        ? tx.execute<{ id: string }>(sql`
            insert into recipients (owner_user_id, identifier, name, kind, account_id, category_id)
            select auth.uid(), ${input.identifier}, ${input.name}, ${input.kind}, ${input.accountId}::uuid, ${input.categoryId}::uuid
            where ${references}
            returning id`)
        : tx.execute<{ id: string }>(sql`
            update recipients
               set identifier = ${input.identifier}, name = ${input.name}, kind = ${input.kind},
                   account_id = ${input.accountId}::uuid, category_id = ${input.categoryId}::uuid
             where id = ${input.id}::uuid and ${references}
            returning id`),
    );
    if (!row) throw new ActionError("errors.notFound");
    return { id: row.id };
  } catch (error) {
    if (pgConstraintName(error) === "recipients_owner_identifier_unique") {
      throw new ActionError("recipients.errors.duplicate");
    }
    throw error;
  }
}

export async function deleteRecipient(id: string): Promise<boolean> {
  const rows = await withUserDb(async (tx) =>
    tx.delete(recipients).where(eq(recipients.id, id)).returning({ id: recipients.id }),
  );
  return rows.length > 0;
}
