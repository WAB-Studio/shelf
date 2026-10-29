// Where the month amount sheet goes back to (RP-28): the screen that opened it
// names itself in `volver`. Only a path this app draws is followed — an
// open redirect would send a person off-site from a link anyone can craft.
const FALLBACK_TAIL = "/meses";
const MES_QUERY = /^\/mes(\?[A-Za-z0-9=&_.%-]*)?$/;
const MONTH_PATH = /^\/meses\/\d{4}-(0[1-9]|1[0-2])$/;

export function returnTo(raw: string | null, goalId: string): string {
  const goal = `/metas/${goalId}`;
  const fallback = `${goal}${FALLBACK_TAIL}`;
  if (raw === null) return fallback;
  if (raw === goal || raw === fallback || MES_QUERY.test(raw)) return raw;
  if (raw.startsWith(`${goal}/`) && MONTH_PATH.test(raw.slice(goal.length))) return raw;
  return fallback;
}

// The link that opens the sheet from `from`, naming it so the sheet returns there.
export function planHrefFrom(goalId: string, month: string, from: string): string {
  return `/metas/${goalId}/meses?planear=${month}&volver=${encodeURIComponent(from)}`;
}
