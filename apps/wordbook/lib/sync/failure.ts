export type SyncFailure = "offline" | "quota" | "server";

type FailureInput =
  | { status: number; body: unknown }
  | { error: unknown; online: boolean };

// A rejected `fetch` is a TypeError; a body that fails the schema is not.
export function failureCause(input: FailureInput): SyncFailure {
  if ("status" in input) {
    const body = input.body as { error?: unknown } | null;
    return input.status === 429 && body?.error === "quota" ? "quota" : "server";
  }
  return !input.online || input.error instanceof TypeError ? "offline" : "server";
}
