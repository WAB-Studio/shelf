// What the database will take from an account's pockets for a movement (RF-249), worked out ahead so the
// form can say it before saving (RF-276). It restates the rule and never changes it: the shortfall the
// movement causes in the free part, at most its own amount, drawn largest pocket first. Integer cents.

export type CoverPocket = { id: string; name: string; balanceCents: number; openedOn: string };

// An asset a debt may be paid from: its free balance in the currency it settles in and the pockets that
// balance leaves out, which the payment may draw from (RF-249).
export type PayFromAccount = {
  id: string;
  name: string;
  balanceCents: number;
  pockets: CoverPocket[];
};

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

// The slice of an account the cover reads: the form options and the payment dialogs both hold it.
export type CoverAccount = {
  id: string;
  name: string;
  kind: string;
  parentAccountId?: string | null;
  initialBalanceOn: string;
  settlementCurrency: string;
  balances: { currency: string; balanceCents: number }[];
};

export type CoverRead = {
  // What the pockets will give, null when they give nothing.
  plan: PocketCover | null;
  // The account's balance once the movement and the pockets' help land, when that is below zero.
  overdraft: { accountName: string; balanceCents: number } | null;
};

/**
 * What a payment out of an asset account does: the pockets it draws from (RF-249) and whether the account is
 * still left below zero after them. The movement form, «Pagar» and the card payment say it the same way.
 */
export function readCover({
  accounts,
  fromAccountId,
  toAccountId,
  amountCents,
  currency,
  occurredOn,
}: {
  accounts: readonly CoverAccount[];
  fromAccountId: string | null | undefined;
  toAccountId: string | null | undefined;
  amountCents: number | null;
  currency: string;
  occurredOn: string;
}): CoverRead {
  const none: CoverRead = { plan: null, overdraft: null };
  const account = accounts.find((one) => one.id === fromAccountId);
  if (!account || account.kind !== "asset" || amountCents === null || amountCents <= 0) return none;
  if (currency !== account.settlementCurrency) return none;
  // Paying into one's own pocket moves money inside the account.
  if (accounts.find((one) => one.id === toAccountId)?.parentAccountId === account.id) return none;

  const balanceOf = (row: CoverAccount) =>
    row.balances.find((balance) => balance.currency === account.settlementCurrency)?.balanceCents ?? 0;
  const pockets: CoverPocket[] = accounts
    .filter((one) => one.parentAccountId === account.id)
    .map((one) => ({ id: one.id, name: one.name, balanceCents: balanceOf(one), openedOn: one.initialBalanceOn }));

  const freeCents = balanceOf(account);
  const cover = planPocketCover({ amountCents, freeCents, pockets, occurredOn });
  const left = freeCents - amountCents + cover.totalCents;
  return {
    plan: cover.totalCents > 0 ? cover : null,
    overdraft: left < 0 ? { accountName: account.name, balanceCents: left } : null,
  };
}
