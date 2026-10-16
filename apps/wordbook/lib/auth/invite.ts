// The one shape `reading.allowed_emails` stores (RL-69). A dotless domain is refused here though the
// column's CHECK would take it: no address a reader can open mail at has one.
const shape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address as the list stores it, lowercase and trimmed, or null when it is not one. */
export function normaliseInvite(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return shape.test(email) ? email : null;
}
