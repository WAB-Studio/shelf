/**
 * The only error a server action is allowed to surface. Its message is a
 * catalogue key, never a sentence: the client renders it through
 * `useTranslations`, so an error path stays translated like everything else.
 */
export class ActionError extends Error {
  constructor(public messageKey: string) {
    super(messageKey);
    this.name = "ActionError";
  }
}

// The refusals a trigger raises with its own sqlstate (RF-162, migration 0071). Each code is
// raised by one trigger alone, so it reads the same through every action and every tool that reaches it.
export const DATABASE_REFUSALS: Record<string, string> = {
  MO001: "errors.movementBeforeOpening",
  MO002: "accounts.errors.openingAfterMovement",
};
