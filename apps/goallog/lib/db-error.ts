// drizzle-orm wraps a raw driver error in `DrizzleQueryError` and hangs the
// real `postgres` error off `.cause`, so the SQLSTATE is not on the thrown
// error itself — reading `error.code` there is always `undefined`
// (`apps/pulsar/scripts/check-day.ts` proves it).
// `apps/orbit/lib/db-error.ts` walks the same chain; copied rather than
// promoted, since `packages/` gets nothing this slice does not ask for twice.
const MAX_CAUSE_HOPS = 5;

export function pgCode(error: unknown): string | undefined {
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
