const KEY = "goallog.pending-sign-in";

// The code the mail carries stops working after an hour (RP-136); a record older than that is not a step to reopen.
export const PENDING_LIFETIME_MS = 60 * 60 * 1000;

// Remembers the address a code was sent to, so a reload or a relaunch of the installed app reopens the code step.
export function savePending(email: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ email, at: now }));
  } catch {
    // Storage unavailable: a reload shows the form again.
  }
}

// `null` for nothing stored, a record past its hour, or anything unreadable. An expired record is dropped.
export function readPending(now: number = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: unknown; at?: unknown };
    if (typeof parsed.email !== "string" || typeof parsed.at !== "number") {
      clearPending();
      return null;
    }
    if (now - parsed.at >= PENDING_LIFETIME_MS || parsed.at > now) {
      clearPending();
      return null;
    }
    return parsed.email;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}
