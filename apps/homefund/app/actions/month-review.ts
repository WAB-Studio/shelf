"use server";

import { refresh } from "next/cache";

import { UnmarkRefusedError, markReviewed, unmarkReviewed } from "@/db/queries/month-review";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError } from "@/lib/errors";
import { authActionClient } from "@/lib/safe-action";
import { markReviewedSchema } from "@/lib/validation/month-review";

/**
 * «Está bien» on an item of «Revisar el mes» (RF-155): one mark per movement, kept once. A movement
 * the caller only reads is refused by the insert policy, and says so in words.
 */
export const markReviewedAction = authActionClient
  .inputSchema(markReviewedSchema)
  .action(async ({ parsedInput }) => {
    try {
      await markReviewed(parsedInput);
    } catch (error) {
      if (pgErrorCode(error) === "42501") throw new ActionError("review.errors.cannotMark");
      throw error;
    }
    refresh();
  });

/**
 * «Deshacer» on an item under «Revisados» (RF-163): its marks go and it waits again. A movement the
 * caller only reads deletes nothing under the policy, and that is said in words.
 */
export const unmarkReviewedAction = authActionClient
  .inputSchema(markReviewedSchema)
  .action(async ({ parsedInput }) => {
    try {
      await unmarkReviewed(parsedInput);
    } catch (error) {
      if (error instanceof UnmarkRefusedError) throw new ActionError("review.errors.cannotUndo");
      throw error;
    }
    refresh();
  });
