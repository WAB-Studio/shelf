// What the database will take from an account's pockets for a movement (RF-249), worked out ahead so the
// form can say it before saving (RF-276). It restates the rule and never changes it: the shortfall the
// movement causes in the free part, at most its own amount, drawn largest pocket first. Integer cents.

export type CoverPocket = { id: string; name: string; balanceCents: number; openedOn: string };

export type PocketCover = {
  takes: { id: string; name: string; cents: number }[];
  totalCents: number;
};

const NONE: PocketCover = { takes: [], totalCents: 0 };

export function planPocketCover({
  amountCents,
  freeCents,
  pockets,
  occurredOn,
}: {
  amountCents: number;
  // The account's own balance, without its pockets, before this movement.
  freeCents: number;
  pockets: readonly CoverPocket[];
  occurredOn: string;
}): PocketCover {
  if (amountCents <= 0) return NONE;

  // A free part already below zero owes the movement's whole amount, not the old hole.
  const shortfall = Math.min(amountCents, amountCents - Math.max(freeCents, 0));
  if (shortfall <= 0) return NONE;

  const takes: PocketCover["takes"] = [];
  let remaining = shortfall;
  // A pocket opened after the movement's day gives nothing; one holding nothing is skipped.
  const usable = pockets
    .filter((pocket) => pocket.balanceCents > 0 && pocket.openedOn <= occurredOn)
    .sort((a, b) => b.balanceCents - a.balanceCents);

  for (const pocket of usable) {
    if (remaining <= 0) break;
    const cents = Math.min(pocket.balanceCents, remaining);
    takes.push({ id: pocket.id, name: pocket.name, cents });
    remaining -= cents;
  }

  return { takes, totalCents: shortfall - remaining };
}
