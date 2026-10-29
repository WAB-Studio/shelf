"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { keyNameSchema } from "@/lib/forms";
import { issueKey } from "@/lib/keys";
import { getPerson, withTimeDb } from "@/lib/session";

export type CreateKeyResult = { ok: true; key: string } | { ok: false; error: "nameInvalid" | "signedOut" };

// Shown once (RT-03, RT-06): the key leaves here and is never read back.
export async function createKey(name: string): Promise<CreateKeyResult> {
  const parsed = keyNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, error: "nameInvalid" };
  const person = await getPerson();
  if (person === null) return { ok: false, error: "signedOut" };

  const { key } = await withTimeDb((tx) => issueKey(tx, person.id, parsed.data));
  revalidatePath("/llaves");
  return { ok: true, key };
}

// The update policy admits only the person's own live key.
export async function revokeKey(id: string): Promise<{ ok: boolean }> {
  if (!z.uuid().safeParse(id).success || (await getPerson()) === null) return { ok: false };
  const rows = await withTimeDb((tx) =>
    tx.execute(sql`update timelog.access_keys set revoked_at = now() where id = ${id} returning id`),
  );
  revalidatePath("/llaves");
  return { ok: rows.length === 1 };
}
