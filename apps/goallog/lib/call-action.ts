// Awaits a server action and answers with a result, never an exception: a
// request that never arrived (no network, a database outage) becomes the
// screen's refusal so the screen keeps what was typed. A resolved result,
// an `ok: false` included, passes through untouched. The error is dropped
// unread: its message may carry what the person typed.
export async function callAction<T extends { ok: boolean }>(
  act: () => Promise<T>,
): Promise<T | { ok: false; error: "tree.note.failed" }> {
  try {
    return await act();
  } catch {
    return { ok: false, error: "tree.note.failed" };
  }
}
