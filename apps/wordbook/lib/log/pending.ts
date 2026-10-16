/** Own rows past the cursor; `device` absent or null marks a row this device recorded. */
export function countPending(rows: readonly { id?: number; device?: string | null }[], cursor: number | null): number {
  return rows.filter((row) => row.device == null && (cursor === null || (row.id ?? 0) > cursor)).length;
}
