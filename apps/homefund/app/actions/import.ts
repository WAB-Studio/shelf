"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { commitImport, ImportAlreadyCommitting } from "@/db/queries/import-commit";
import type {
  CommitInput,
  CommitRow,
  CommitScope,
  RestoredBudget,
  RestoredContribution,
  RestoredGoal,
  RestoredStatement,
} from "@/db/queries/import-commit";
import { getUserGroup } from "@/db/queries/groups";
import { withUserDb } from "@/db/session";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { runImportPipeline } from "@/lib/spreadsheet/import-pipeline";
import type { ImportResult, RowFieldError } from "@/lib/spreadsheet/import-pipeline";
import type { SheetEntity } from "@/lib/spreadsheet/schema";
import type { ImportedAdjustment } from "@/lib/validation/account-reconciliation";
import type { CreateAccountInput } from "@/lib/validation/account";
import type { CreateCategoryInput } from "@/lib/validation/category";
import type { CreateLabelInput } from "@/lib/validation/label";
import type { CreateMemberInput } from "@/lib/validation/member";
import type { CreateRecurringRuleInput } from "@/lib/validation/recurring-rule";
import type { DebtTermsInput } from "@/lib/validation/debt-terms";
import type { CreateTransactionInput } from "@/lib/validation/transaction";

// The upload guards raise these; the shared pipeline owns the rest (RF-48).
const FILE_REQUIRED = "data.import.errors.fileRequired";
const FILE_TYPE = "data.import.errors.fileType";

// A commit is all-or-nothing (RF-51): a single errored row across any sheet stops the
// write before it starts, so the caller never lands a partial import.
const FILE_HAS_ERRORS = "data.import.errors.hasErrors";

// Another tab's commit of the same file wrote its keys first; nothing of this one landed.
const ALREADY_COMMITTING = "data.import.errors.alreadyCommitting";

type PreviewRow = {
  index: number;
  // The spreadsheet's own row number (RF-51) — what a person sees opening the file
  // in Excel, never `index`: a blank row skipped upstream pulls the two apart.
  sheetRow: number;
  status: "new" | "update";
  errors: RowFieldError[];
};

type PreviewEntity = {
  entity: SheetEntity;
  rows: PreviewRow[];
};

export type ImportPreview = {
  perEntity: PreviewEntity[];
  totals: { new: number; update: number; error: number };
};

/**
 * The import preview (RF-51/52): parse the upload, validate every row before a single
 * write, resolve references against existing scope unioned with the file's own new
 * accounts and categories, and classify each row new-vs-update by its stable key.
 * Writes NOTHING — the caller confirms first, a later commit action applies the same
 * `runImportPipeline` result. The resolved objects stay server-side; the payload
 * carries only each row's position, classification and its errors, each already
 * traced back to its column and its raw cell (RF-51).
 */
export const previewImportAction = authActionClient
  .inputSchema(z.instanceof(FormData))
  .action(async ({ parsedInput: formData }): Promise<ImportPreview> => {
    const file = formData.get("file");
    if (!(file instanceof File)) throw new ActionError(FILE_REQUIRED);
    if (!file.name.toLowerCase().endsWith(".xlsx")) throw new ActionError(FILE_TYPE);

    const result = await runImportPipeline({ buffer: await file.arrayBuffer() });

    return {
      perEntity: result.perEntity.map((entity) => ({
        entity: entity.entity,
        rows: entity.rows.map((row) => ({
          index: row.index,
          sheetRow: row.sheetRow,
          status: row.status,
          errors: row.errors,
        })),
      })),
      totals: result.totals,
    };
  });

// One entity's passing rows in the shape the commit writes: its classification, its
// stable key, the placeholder a reference to it resolves to, and its validated payload.
function rowsFor<T>(
  result: ImportResult,
  entity: SheetEntity,
  keep: (object: unknown) => boolean = () => true,
): CommitRow<T>[] {
  const bucket = result.perEntity.find((set) => set.entity === entity);
  return (bucket?.rows ?? []).filter((row) => keep(row.object)).map((row) => ({
    index: row.index,
    sheetRow: row.sheetRow,
    status: row.status,
    externalRef: row.externalRef,
    placeholderId: row.placeholderId,
    object: row.object as T,
  }));
}

// The transactions sheet carries a backup's adjustments beside its movements; only the
// validated adjustment shape says `adjustment: true`.
function isAdjustment(object: unknown): boolean {
  return typeof object === "object" && object !== null && "adjustment" in object;
}

/**
 * The import commit (RF-51/52/45): re-run the SAME pipeline server-side — never trust a
 * client-sent preview (RNF-10) — and refuse the whole file if any row errored, so the
 * write is all-or-nothing. The scope a personal-or-group row lands in is resolved from
 * the session here, not the file, then the entire write runs in one `withUserDb`
 * transaction so the audit trigger captures every insert and update and any single
 * failure rolls all of it back.
 */
export const commitImportAction = authActionClient
  .inputSchema(z.instanceof(FormData))
  .action(async ({ parsedInput: formData, ctx }) => {
    const file = formData.get("file");
    if (!(file instanceof File)) throw new ActionError(FILE_REQUIRED);
    if (!file.name.toLowerCase().endsWith(".xlsx")) throw new ActionError(FILE_TYPE);

    const result = await runImportPipeline({ buffer: await file.arrayBuffer() });
    if (result.totals.error > 0) throw new ActionError(FILE_HAS_ERRORS);

    const group = await getUserGroup();
    const scope: CommitScope = { userId: ctx.user.id, groupId: group?.id ?? null };

    const input: CommitInput = {
      members: rowsFor<CreateMemberInput>(result, "members"),
      categories: rowsFor<CreateCategoryInput>(result, "categories"),
      labels: rowsFor<CreateLabelInput>(result, "labels"),
      accounts: rowsFor<CreateAccountInput>(result, "accounts"),
      recurringRules: rowsFor<CreateRecurringRuleInput>(result, "recurringRules"),
      transactions: rowsFor<CreateTransactionInput>(result, "transactions", (object) => !isAdjustment(object)),
      adjustments: rowsFor<ImportedAdjustment>(result, "transactions", isAdjustment),
      budgets: rowsFor<RestoredBudget>(result, "budgets"),
      goals: rowsFor<RestoredGoal>(result, "goals"),
      goalContributions: rowsFor<RestoredContribution>(result, "goalContributions"),
      debts: rowsFor<DebtTermsInput>(result, "debts"),
      statements: rowsFor<RestoredStatement>(result, "statements"),
    };

    const outcome = await withUserDb((tx) => commitImport(tx, input, scope)).catch((error: unknown) => {
      throw error instanceof ImportAlreadyCommitting ? new ActionError(ALREADY_COMMITTING) : error;
    });
    refresh();
    return outcome;
  });
