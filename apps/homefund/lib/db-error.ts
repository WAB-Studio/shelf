// What a code means is a call-site decision: the same Postgres code
// (23505, a unique violation) can name a duplicate account today and a
// duplicate movement tomorrow, so no mapping table lives here.
//
// drizzle-orm throws DrizzleQueryError and hangs the driver's PostgresError
// off `.cause`, so the code is found by walking the cause chain, not by
// reading the thrown error itself.
const MAX_CAUSE_HOPS = 5;

export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;

  for (let hop = 0; hop < MAX_CAUSE_HOPS; hop++) {
    if (typeof current !== "object" || current === null) return undefined;

    if ("code" in current) {
      const { code } = current as { code: unknown };
      if (typeof code === "string") return code;
    }

    current = "cause" in current ? (current as { cause: unknown }).cause : undefined;
  }

  return undefined;
}
