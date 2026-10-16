import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/lib/session";
import type { EvidenceDay } from "@/lib/day/types";

export type { EvidenceDay };

/**
 * The one door a source answers behind (RNP-10). `personId` is the person the
 * caller already verified through `withReadingDb`'s own settle — a reader
 * never re-decides who is asking, the transaction's policies already have.
 * `tx` is that settled transaction, `[from, to]` a civil-day range inclusive
 * on both ends, `zone` the person's own zone (RNP-06). Nothing that calls
 * this learns which app answered: that is `registry.ts`'s one job.
 *
 * `from`/`to` are a bound, not necessarily a value: a plain civil-day string
 * (what `lib/queries/day.ts` and `lib/queries/week.ts` already know without a
 * round trip) or a `SQL` fragment the caller supplies to be evaluated inside
 * the reader's own single statement — what `lib/queries/goal.ts` needs, since
 * a goal's own span lives in a row only that statement can see. Either way a
 * reader interpolates it into its own predicate and never inspects it: a
 * `SQL` bound naming `"goals"."goals"` teaches this type nothing about that
 * schema, and a source's reader (`reading-lookups.ts`) never spells the name
 * out — only the caller that built the fragment does.
 */
export type EvidenceReader = (args: {
  personId: string;
  from: string | SQL;
  to: string | SQL;
  zone: string;
  tx: Transaction;
}) => Promise<EvidenceDay[]>;
