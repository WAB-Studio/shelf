import { createHash } from "node:crypto";

// The pure body `client-budget.ts` wraps with `env.CLIENT_KEY_SALT`. No
// `server-only` import here, on purpose, the same way `verify-magic-link.ts`
// takes `verifyOtp` as a parameter instead of reaching for config: the salt
// is passed in, so this loads outside a Next build and a spec can drive it
// with a fabricated salt instead of grepping its source.

// The one formula: an address already extracted, hashed with its salt.
// `clientKey` below wraps it with the extraction; a script that already
// holds an address (a synthetic caller IP, never a `Request`) calls this
// directly instead of reimplementing the hash.
export function clientKeyFromAddress(address: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${address}`).digest("hex");
}

// Headers alone, so a server action holding `headers()` and a route holding
// a `Request` derive one and the same key.
export function clientKeyFromHeaders(headers: Headers, salt: string | undefined): string | null {
  if (!salt) return null;
  const forwardedFor = headers.get("x-forwarded-for");
  const address = forwardedFor?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  if (!address) return null;
  return clientKeyFromAddress(address, salt);
}

export function clientKey(request: Request, salt: string | undefined): string | null {
  return clientKeyFromHeaders(request.headers, salt);
}

// Each scope is its own `reading.client_spend` row: a caller's translations
// never eat into their word lookups or their sign-in links. `signin-to` keys
// an address, not a caller.
export type ClientScope = "text" | "translate" | "signin" | "signin-to";

export function scopeClientKey(scope: ClientScope, key: string | null): string | null {
  return key ? `${scope}:${key}` : null;
}
