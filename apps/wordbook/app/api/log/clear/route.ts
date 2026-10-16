import "server-only";

import { sql } from "drizzle-orm";

import { getReader, withReaderDb } from "@/lib/session";

// Never a candidate for the route cache: the same reasoning as
// `app/api/log/sync/route.ts`, though this route answers no state a cache
// could even name.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * «Vaciar aquí y en mi cuenta» (`RegistroVaciarConfirmar`): empties this
 * reader's whole account copy of `lookups`, every device's rows at once —
 * the confirm screen names no device of its own, unlike `retireDevice`
 * (`lib/sync/devices.ts`), which only ever drops one. `reading.devices`
 * stays: RL-25's list still answers who copied here, now with nothing left
 * to count — `listDevices`'s own `left join lateral` derives that count
 * from `lookups` itself, never stores it, so an emptied copy reads as zero
 * with no row to fix up.
 *
 * No body, no Zod schema: the only input this route reads is the session
 * itself, so there is nothing a form could get wrong for a schema to catch.
 *
 * ONE round trip past the session's own settle statement. The `where`
 * narrows the index; the policy — `lookups_delete_self` — is what actually
 * keeps this off another reader's rows (RNL-10), proven driving it with two
 * identities in `e2e/registro.spec.ts`, never asserted from the migration.
 */
export async function DELETE(): Promise<Response> {
  const reader = await getReader();
  if (!reader) return json({ error: "unauthorized" }, 401);

  await withReaderDb((tx) => tx.execute(sql`delete from reading.lookups where user_id = ${reader.id}`));

  return json({}, 200);
}
