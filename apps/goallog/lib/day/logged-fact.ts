import { civilDateInZone } from "@/lib/zone";

// The one fact `day-row.tsx` and `quantity-sheet.tsx` show and undo for a
// done commitment — the most recently written one, when more than one
// landed the same day (an old accumulation from before "Cambiar" replaced
// instead of adding). Neither `DaySlot` nor `deriveDay` carries an
// id or a note: they answer "is this satisfied", not "which row do I undo",
// so this rides beside `DayView` rather than inside it.
//
// Pure and DB-free on purpose: `lib/queries/day.ts` carries `import
// "server-only"`, which a plain `node:test` run cannot resolve outside
// Next's own bundler. Kept here, beside the rest of the engine's pure
// functions, so its own rule — the latest write wins, not the first row in
// the array — has a unit test that does not need a database to run.
//
// `writtenAt` is the instant (`facts.written_at`), `writtenOn` is that
// instant's own civil day (RP-06), read through `civilDateInZone` alone —
// `lib/zone.ts` carries no `server-only`, so this file stays pure. A screen
// for a past day compares `writtenOn` with the day it draws, never the
// instant string with the day string (`docs/TRAPS.md`'s own timestamptz trap).
export type LoggedFact = {
  factId: string;
  quantity: number | null;
  note: string | null;
  writtenAt: string;
  writtenOn: string;
};

export type FactForCommitment = {
  id: string;
  commitmentId: string | null;
  writtenAt: string;
  quantity: number | null;
  note: string | null;
};

export function latestFactByCommitment(
  facts: FactForCommitment[],
): Record<string, LoggedFact> {
  const latest: Record<string, FactForCommitment> = {};

  for (const row of facts) {
    if (row.commitmentId === null) continue;
    const current = latest[row.commitmentId];
    if (!current || row.writtenAt > current.writtenAt) {
      latest[row.commitmentId] = row;
    }
  }

  return Object.fromEntries(
    Object.entries(latest).map(([commitmentId, row]) => [
      commitmentId,
      {
        factId: row.id,
        quantity: row.quantity,
        note: row.note,
        writtenAt: row.writtenAt,
        writtenOn: civilDateInZone(new Date(row.writtenAt)),
      },
    ]),
  );
}
