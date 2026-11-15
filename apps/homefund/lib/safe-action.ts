import "server-only";

import { createSafeActionClient } from "next-safe-action";

import { getSessionUser } from "@/db/session";
import { pgErrorCode } from "@/lib/db-error";
import { ActionError, DATABASE_REFUSALS } from "@/lib/errors";

/**
 * Every action starts here. `serverError` is always a message key, so the form
 * that receives it can translate it.
 */
export const actionClient = createSafeActionClient({
  defaultValidationErrorsShape: "flattened",
  handleServerError(error) {
    // The raw error never crosses the wire: a database message names tables,
    // columns and policies, and a rejected policy is a map of the model.
    console.error("action failed", error);

    if (error instanceof ActionError) return error.messageKey;
    const code = pgErrorCode(error);
    return code !== undefined && Object.hasOwn(DATABASE_REFUSALS, code)
      ? DATABASE_REFUSALS[code]
      : "errors.unexpected";
  },
});

// The session is verified from the JWT, not read from a cookie value.
export const authActionClient = actionClient.use(async ({ next }) => {
  const user = await getSessionUser();
  if (!user) throw new ActionError("errors.unauthenticated");

  return next({ ctx: { user } });
});
