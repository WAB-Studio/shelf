// RF-146 (D5): the address a code was sent to outlives a relaunch of the installed
// app. Storage can refuse (private mode, quota) or be absent (server render), so
// every call swallows that and reads as "nothing pending".
const KEY = "homefund.pending-sign-in";
const HOLD_MS = 60 * 60_000;

type Pending = { email: string; sentAt: number };

function isPending(value: unknown): value is Pending {
  if (typeof value !== "object" || value === null) return false;
  const { email, sentAt } = value as Record<string, unknown>;
  return typeof email === "string" && email !== "" && typeof sentAt === "number";
}

export function writePending(email: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email, sentAt: Date.now() } satisfies Pending));
  } catch {
    // Without storage the code step simply does not survive a relaunch.
  }
}

export function clearPending(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing was kept, so nothing is left to clear.
  }
}

export function readPending(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!isPending(value)) return null;
    if (Date.now() - value.sentAt >= HOLD_MS) {
      clearPending();
      return null;
    }
    return value.email;
  } catch {
    return null;
  }
}
