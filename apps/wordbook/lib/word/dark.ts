export type PaidRoute = "word/text" | "word/unlisted" | "phrase/notes" | "translate" | "signin";

export type DarkReason =
  | "no-key"
  | "no-cap"
  | "no-caller"
  | "caller-share"
  | "caller-cap"
  | "day-cap"
  | "claim-error"
  | "cache-error"
  | "model-failed";

// One line per refusal, naming the route and the reason and nothing the
// reader sent: no word, phrase, hash, caller key, address or env value.
export function logDark(route: PaidRoute, reason: DarkReason): void {
  console.warn("[paid-dark]", route, reason);
}
