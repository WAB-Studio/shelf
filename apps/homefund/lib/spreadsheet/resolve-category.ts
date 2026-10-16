// A category is stored on a movement only when it shares the scope of the account
// the movement lands in (RF-51), so the importer picks among same-named categories
// by that scope rather than by name alone (RF-140).

export type ScopeKey = `user:${string}` | `group:${string}`;

export type CategoryResolution = { id: string } | { error: "unknown" | "ambiguous" | "outOfScope" };

// The schema keeps owner and group exclusive; a row carrying both is read as the
// group's, the scope a shared movement belongs to.
export function scopeKeyOf(row: { ownerUserId: string | null; groupId: string | null }): ScopeKey | null {
  if (row.groupId !== null) return `group:${row.groupId}`;
  if (row.ownerUserId !== null) return `user:${row.ownerUserId}`;
  return null;
}

export function resolveCategoryInScope(
  candidateIds: readonly string[],
  accountScope: ScopeKey | null,
  scopeById: ReadonlyMap<string, ScopeKey>,
): CategoryResolution {
  if (candidateIds.length === 0) return { error: "unknown" };

  // No account resolved: there is no scope to filter by, so the name alone decides.
  if (accountScope === null) {
    return candidateIds.length === 1 ? { id: candidateIds[0] } : { error: "ambiguous" };
  }

  // A candidate absent from the map has no known scope and never matches.
  const kept = candidateIds.filter((id) => scopeById.get(id) === accountScope);
  if (kept.length === 1) return { id: kept[0] };
  return kept.length === 0 ? { error: "outOfScope" } : { error: "ambiguous" };
}
