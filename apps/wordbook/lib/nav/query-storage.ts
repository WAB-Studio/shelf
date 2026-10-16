// Carries the search box's last settled text past a trip away from `/`.
// `search-screen.tsx` writes the URL with raw `history.pushState`, which
// `useSearchParams()` does not observe, and `BottomNav` remounts on every
// route change, so React state alone would not survive the trip.
const KEY = "voyager:nav-query";

// Private browsing can refuse storage; every function then does nothing and
// the read answers "", so Buscar falls back to a bare `/`.
export function readNavQuery(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeNavQuery(query: string): void {
  if (typeof window === "undefined") return;
  try {
    if (query) window.sessionStorage.setItem(KEY, query);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to recover: the next read falls back to "".
  }
}

export function clearNavQuery(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Same as `writeNavQuery`.
  }
}
