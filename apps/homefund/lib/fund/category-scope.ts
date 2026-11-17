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

// A proposed category of another scope than the proposed account, or of another kind than the movement, is
// read as no category: the split trigger would refuse it, so it is neither shown nor sent, and the person
// picks one of the account's own scope and the movement's own kind (RF-140, RF-278).
export function proposedCategoryId(
  delivery: {
    proposedCategoryId: string | null;
    proposedAccountId: string | null;
    proposedDirection: "income" | "expense" | "transfer" | null;
  },
  options: {
    categories: { id: string; scope: CategoryScope; kind: string; children: readonly { id: string }[] }[];
    accounts: ScopedAccount[];
  },
): string | null {
  const categoryId = delivery.proposedCategoryId;
  if (categoryId === null || delivery.proposedDirection === "transfer") return null;
  const category = options.categories.find(
    (one) => one.id === categoryId || one.children.some((child) => child.id === categoryId),
  );
  if (category === undefined) return categoryId;

  const scope = scopeOfAccounts([delivery.proposedAccountId], options.accounts);
  if (scope !== null && category.scope !== scope) return null;
  return category.kind === (delivery.proposedDirection === "income" ? "income" : "expense") ? categoryId : null;
}
