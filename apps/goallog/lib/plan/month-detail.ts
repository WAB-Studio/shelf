/** A «Por mes» row's second line: the month's state, then its task count, joined by « · ». Null when both are absent. */
export function monthDetail(state: string | null, count: string | null): string | null {
  const parts = [state, count].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}
