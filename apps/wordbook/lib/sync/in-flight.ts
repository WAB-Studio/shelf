// Callers that arrive while a run is pending get its promise; the slot clears
// on settle, resolved or rejected, so a failure never sticks.
export function shareInFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const started = run().finally(() => {
      pending = null;
    });
    pending = started;
    return started;
  };
}
