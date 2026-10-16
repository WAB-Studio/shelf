"use server";

import { refresh } from "next/cache";

import { createCategory, deleteCategory, updateCategory } from "@/db/queries/categories";
import type { CategoryScope } from "@/db/queries/categories";
import { getUserGroup } from "@/db/queries/groups";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  createCategorySchema,
  deleteCategorySchema,
  updateCategorySchema,
} from "@/lib/validation/category";

// The trigger raises one code, 23514, for four refusals; three are
// nesting-shaped and the fourth, a kind mismatch, is the one the parent picker
// already prevents. A null parent leaves the trigger before it can raise at
// all, so that branch only guards against the trigger changing shape.
function categoryConstraintErrorKey(parentId: string | null): string {
  return parentId ? "errors.categoryNesting" : "errors.categoryKindMismatch";
}

/**
 * Creates a category (RF-63, RF-27). Depth, kind agreement and same-scope
 * parentage are the trigger's and the composite foreign key's to enforce;
 * this action only turns their shared refusal code into a sentence. The scope
 * is the caller's group when they belong to one, otherwise their personal set.
 */
export const createCategoryAction = authActionClient
  .inputSchema(createCategorySchema)
  .action(async ({ parsedInput, ctx }) => {
    const group = await getUserGroup();
    const scope: CategoryScope = group
      ? { groupId: group.id }
      : { ownerUserId: ctx.user.id };

    let categoryId: string;
    try {
      ({ categoryId } = await createCategory({ ...parsedInput, scope }));
    } catch (error) {
      if (pgErrorCode(error) === "23514") {
        throw new ActionError(categoryConstraintErrorKey(parsedInput.parentId));
      }
      throw error;
    }

    refresh();
    return { categoryId };
  });

/**
 * Renames, recolours or reparents a category. `kind` is immutable and never
 * travels in the payload, so the mapping below reads the same as create's.
 */
export const updateCategoryAction = authActionClient
  .inputSchema(updateCategorySchema)
  .action(async ({ parsedInput }) => {
    let updated: boolean;
    try {
      updated = await updateCategory(parsedInput);
    } catch (error) {
      if (pgErrorCode(error) === "23514") {
        throw new ActionError(categoryConstraintErrorKey(parsedInput.parentId));
      }
      throw error;
    }

    if (!updated) throw new ActionError("errors.notFound");

    refresh();
  });

/**
 * Deletes a category. 23503 is the composite foreign key a transaction will
 * hold once transactions exist; nothing references categories yet.
 */
export const deleteCategoryAction = authActionClient
  .inputSchema(deleteCategorySchema)
  .action(async ({ parsedInput }) => {
    let deleted: boolean;
    try {
      deleted = await deleteCategory(parsedInput);
    } catch (error) {
      if (pgErrorCode(error) === "23503") throw new ActionError("errors.categoryInUse");
      throw error;
    }

    if (!deleted) throw new ActionError("errors.notFound");

    refresh();
  });
