"use server";

import { refresh } from "next/cache";

import { deleteCategory, updateCategory } from "@/db/queries/categories";
import { categoryConstraintErrorKey, openCategory } from "@/db/queries/ledger-write";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import {
  createCategoryInputSchema,
  deleteCategorySchema,
  updateCategorySchema,
} from "@/lib/validation/category";

/**
 * Creates a category (RF-63, RF-27); the write is `openCategory`'s, shared with `/mcp`.
 */
export const createCategoryAction = authActionClient
  .inputSchema(createCategoryInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    const created = await openCategory(parsedInput, ctx.user.id);

    refresh();
    return created;
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
