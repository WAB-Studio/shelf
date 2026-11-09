// Structural, so this file imports nothing from the server-only db layer.
export type NamedAccount = {
  id: string;
  name: string;
  foreignOwner: boolean;
  ownerName: string | null;
};

// An account's name by id, another member's personal account written with its
// owner after it («Nequi · De Andrea»), so a movement on it never reads as the
// caller's own (RF-58).
export function accountNamesById(
  accounts: readonly NamedAccount[],
  ownerOf: (name: string) => string,
  ownerSomeone: string,
): Map<string, string> {
  return new Map(
    accounts.map((account) => [
      account.id,
      account.foreignOwner
        ? `${account.name} · ${account.ownerName ? ownerOf(account.ownerName) : ownerSomeone}`
        : account.name,
    ]),
  );
}

// A movement that touches another member's personal account is theirs: it is read
// here and never changed (RF-58).
export function touchesForeignAccount(
  movement: { fromAccountId: string | null; toAccountId: string | null },
  accounts: readonly Pick<NamedAccount, "id" | "foreignOwner">[],
): boolean {
  const foreign = new Set(
    accounts.filter((account) => account.foreignOwner).map((account) => account.id),
  );
  return (
    (movement.fromAccountId !== null && foreign.has(movement.fromAccountId)) ||
    (movement.toAccountId !== null && foreign.has(movement.toAccountId))
  );
}
