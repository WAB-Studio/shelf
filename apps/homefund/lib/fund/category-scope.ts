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

// A proposed category of another scope than the proposed account is read as no
// category: the split trigger would refuse it, so it is neither shown nor sent,
// and the person picks one of the account's own scope (RF-140).
export function proposedCategoryId(
  delivery: { proposedCategoryId: string | null; proposedAccountId: string | null },
  options: {
    categories: { id: string; scope: CategoryScope; children: readonly { id: string }[] }[];
    accounts: ScopedAccount[];
  },
): string | null {
  const categoryId = delivery.proposedCategoryId;
  if (categoryId === null) return null;
  const category = options.categories.find(
    (one) => one.id === categoryId || one.children.some((child) => child.id === categoryId),
  );
  const scope = scopeOfAccounts([delivery.proposedAccountId], options.accounts);
  return category && scope !== null && category.scope !== scope ? null : categoryId;
}
