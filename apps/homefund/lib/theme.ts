// Device-scoped theme: no React, no import, so a Server Component can read `themeScript`
// and a client hook can read everything else from the same source.

export const THEME_STORAGE_KEY = "theme";
export const THEMES = ["light", "dark", "system"] as const;

export type Theme = (typeof THEMES)[number];
export type Appearance = "light" | "dark";

const listeners = new Set<() => void>();

export function isTheme(value: string | null): value is Theme {
  return (THEMES as readonly string[]).includes(value ?? "");
}

// The stored value, or "system" when nothing is stored or storage throws.
export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveAppearance(theme: Theme): Appearance {
  if (theme !== "system") return theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Writes storage, sets the <html> class and color-scheme, notifies subscribers.
export function applyTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable; the class below still applies for this page's life.
  }

  const appearance = resolveAppearance(theme);
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(appearance);
  root.style.colorScheme = appearance;

  for (const listener of listeners) listener();
}

export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Runs before hydration, self-contained and never throwing: a failing storage read falls
// to the system appearance, a failing `matchMedia` to light, and a class always lands.
export const themeScript = `(function(){var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)},t=${JSON.stringify(
  THEMES,
)},v="system",a="light";try{var s=localStorage.getItem(k);if(t.indexOf(s)!==-1)v=s}catch(e){}if(v==="system"){try{a=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){}}else a=v;try{var r=document.documentElement;r.classList.remove("light","dark");r.classList.add(a);r.style.colorScheme=a}catch(e){}})();`;
