/**
 * What Bandeja waits on: deliveries to review plus movements with one side unknown («Por completar»).
 * Every surface that shows the inbox count takes it from here, so none disagrees with another.
 */
export function inboxPendingCount(parts: { deliveries: number; awaitingCounterparty: number }): number {
  return parts.deliveries + parts.awaitingCounterparty;
}
