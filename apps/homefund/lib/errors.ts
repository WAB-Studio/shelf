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
