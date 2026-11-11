/** Device-side stamp of the last request the proxy served; the inactivity limit reads it (RF-190). */
export const LAST_SEEN_COOKIE = "homefund-last-seen";

export const LAST_SEEN_MAX_AGE = 60 * 60 * 24 * 400;

// A stamp younger than this is left alone: the cookie is not rewritten on every request.
export const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const KEEP_SIGNED_IN_KEY = "keep_signed_in_days";

/**
 * The person's limit out of verified claims: whole days, or `null` for «Siempre». It rides in
 * `user_metadata`, which the person can rewrite, and that is harmless: it only ever loosens or
 * tightens the person's own device, and no policy reads it.
 */
export function keepDaysFromClaims(claims: Record<string, unknown> | null | undefined): number | null {
  const metadata = claims?.user_metadata;
  if (typeof metadata !== "object" || metadata === null) return null;

  const days = (metadata as Record<string, unknown>)[KEEP_SIGNED_IN_KEY];
  return typeof days === "number" && Number.isInteger(days) && days > 0 ? days : null;
}

export function parseLastSeen(value: string | undefined): number | null {
  if (value === undefined) return null;
  const stamp = Number(value);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

export type InactivityVerdict = "expired" | "stamp" | "fresh";

/**
 * `expired` signs the device out; `stamp` asks for a new last-seen cookie; `fresh` changes nothing.
 * A device with no stamp yet is stamped, never signed out: the limit counts from its first request
 * after it was set.
 */
export function inactivityVerdict(input: { lastSeen: number | null; now: number; days: number | null }): InactivityVerdict {
  const { lastSeen, now, days } = input;
  if (days !== null && lastSeen !== null && now - lastSeen > days * DAY_MS) return "expired";
  if (lastSeen === null || now - lastSeen > LAST_SEEN_REFRESH_MS) return "stamp";

  return "fresh";
}
