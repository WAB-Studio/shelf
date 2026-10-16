"use server";

import { refresh } from "next/cache";

import { getUserGroup } from "@/db/queries/groups";
import { createLabel, deleteLabel, updateLabel } from "@/db/queries/labels";
import type { LabelScope } from "@/db/queries/labels";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  createLabelSchema,
  deleteLabelSchema,
  updateLabelSchema,
} from "@/lib/validation/label";

/**
 * A denied write on a group label reads as `errors.notLeader`, not the house
 * `42501 → errors.notFound`: who governs the group's labels is RF-70's point,
 * so a member is told why rather than told the label vanished. A denial RLS
 * turns into a zero-row result still reads as absent.
 */
function rethrowLabelError(error: unknown): never {
  if (pgErrorCode(error) === "42501") throw new ActionError("errors.notLeader");
  throw error;
}

/**
 * Creates a label (RF-70). The placement picks the scope — the caller's own set
 * or their group's — and the scope columns are resolved from the session, never
 * trusted from the form.
 */
export const createLabelAction = authActionClient
  .inputSchema(createLabelSchema)
  .action(async ({ parsedInput: { placement, name, color }, ctx }) => {
    let scope: LabelScope;
    if (placement === "group") {
      const group = await getUserGroup();
      if (!group) throw new ActionError("errors.notFound");
      scope = { groupId: group.id };
    } else {
      scope = { ownerUserId: ctx.user.id };
    }

    let labelId: string;
    try {
      ({ labelId } = await createLabel({ scope, name, color }));
    } catch (error) {
      rethrowLabelError(error);
    }

    refresh();
    return { labelId };
  });

// Renames or recolours a label; the placement is immutable, so it never travels.
export const updateLabelAction = authActionClient
  .inputSchema(updateLabelSchema)
  .action(async ({ parsedInput }) => {
    let updated: boolean;
    try {
      updated = await updateLabel(parsedInput);
    } catch (error) {
      rethrowLabelError(error);
    }

    if (!updated) throw new ActionError("errors.notFound");

    refresh();
  });

/**
 * Deletes a label. The join's cascade detaches it from its movements, but a
 * budget narrowing on it holds an ON DELETE restrict reference (23503), so that
 * budget has to let go first.
 */
export const deleteLabelAction = authActionClient
  .inputSchema(deleteLabelSchema)
  .action(async ({ parsedInput: { labelId } }) => {
    let deleted: boolean;
    try {
      deleted = await deleteLabel({ labelId });
    } catch (error) {
      if (pgErrorCode(error) === "23503") throw new ActionError("errors.labelInUse");
      rethrowLabelError(error);
    }

    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
