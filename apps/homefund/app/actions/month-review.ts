"use server";

import { refresh } from "next/cache";

import { markReviewed } from "@/db/queries/month-review";
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
