import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { fingerprint } from "@/lib/key-format";
import type { Upload } from "@/lib/upload";

// One statement (RNT-02): `timelog.replace_days` resolves the key and replaces each day whole.
// Null for a key that is unknown or revoked.
export async function replaceDays(key: string, upload: Upload): Promise<number | null> {
  const rows = await db.execute<{ written: number | null }>(
    sql`select timelog.replace_days(${fingerprint(key)}, ${upload.device}, ${JSON.stringify(upload.days)}::jsonb) as written`,
  );
  return rows[0]?.written ?? null;
}
