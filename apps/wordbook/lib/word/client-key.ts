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

// Eight hextets of an IPv6 address, or null when the text is not one. A
// dotted IPv4 tail counts as its two hextets; a zone id is dropped.
function ipv6Hextets(text: string): number[] | null {
  let rest = text.split("%")[0];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const hex = (high: number, low: number) => ((high << 8) | low).toString(16);
    rest = `${rest.slice(0, dotted.index)}${hex(octets[0], octets[1])}:${hex(octets[2], octets[3])}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  return gap < 1 ? null : [...head, ...Array<number>(gap).fill(0), ...tail];
}

// What a cap counts: an IPv4 address as it is, an IPv6 one as its /64 (the
// block one host holds, so rotating inside it buys nothing), anything
// unparseable as written.
function callerNetwork(address: string): string {
  if (!address.includes(":")) return address;
  const hextets = ipv6Hextets(address);
  if (!hextets) return address;
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    return [hextets[6] >> 8, hextets[6] & 255, hextets[7] >> 8, hextets[7] & 255].join(".");
  }
  return `${hextets.slice(0, 4).map((hextet) => hextet.toString(16).padStart(4, "0")).join(":")}::/64`;
}

// Headers alone, so a server action holding `headers()` and a route holding
// a `Request` derive one and the same key. `x-vercel-forwarded-for` is
// written by the platform; the others are the fallback off Vercel.
export function clientKeyFromHeaders(headers: Headers, salt: string | undefined): string | null {
  if (!salt) return null;
  const first = (name: string) => headers.get(name)?.split(",")[0]?.trim();
  const address = first("x-vercel-forwarded-for") || first("x-forwarded-for") || first("x-real-ip");
  if (!address) return null;
  return clientKeyFromAddress(callerNetwork(address), salt);
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
