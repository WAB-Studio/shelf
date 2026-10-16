const DAY_MS = 86_400_000;

// The daily cap counts the UTC day (`sync_rows_today`): the copy resumes at
// the next 00:00 UTC, and exactly 00:00:00 already belongs to the new day.
export function nextQuotaReset(nowMs: number): number {
  return (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS;
}
