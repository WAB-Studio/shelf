export type CategoryScope = "personal" | "group";

interface ScopedAccount {
  id: string;
  groupId: string | null;
}

// A picked account the list does not hold counts as unset.
export function scopeOfAccounts(
  ids: (string | null)[],
  accounts: ScopedAccount[],
): CategoryScope | null {
  const picked = ids
    .map((id) => (id === null ? undefined : accounts.find((a) => a.id === id)))
    .filter((a): a is ScopedAccount => a !== undefined);
  if (picked.length === 0) return null;
  return picked.some((a) => a.groupId !== null) ? "group" : "personal";
}

export function categoriesInScope<T extends { scope: CategoryScope }>(
  categories: T[],
  scope: CategoryScope | null,
): T[] {
  if (scope === null) return categories;
  return categories.filter((c) => c.scope === scope);
}
