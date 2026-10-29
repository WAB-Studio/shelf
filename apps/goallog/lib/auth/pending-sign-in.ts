import { SIGNED_IN_MARKER } from "./signed-in-marker";

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

// The moment the last link landed on this device, or `null` when there is no readable marker.
function readLandingMarker(): number | null {
  try {
    for (const part of document.cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== SIGNED_IN_MARKER) continue;
      const value = Number(rest.join("="));
      return rest.length > 0 && rest.join("=") !== "" && Number.isFinite(value) ? value : null;
    }
  } catch {
    // No cookie jar: no marker.
  }
  return null;
}

// `null` for nothing stored, a record past its hour, a record a later landing spent, or anything unreadable.
// A record that is no longer a step to reopen is dropped.
export function readPending(now: number = Date.now()): { email: string; at: number } | null {
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
    const landed = readLandingMarker();
    if (landed !== null && landed >= parsed.at) {
      clearPending();
      return null;
    }
    return { email: parsed.email, at: parsed.at };
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
