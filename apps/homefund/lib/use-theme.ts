"use client";

import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";

import {
  applyTheme,
  readStoredTheme,
  resolveAppearance,
  subscribeToTheme,
  THEME_STORAGE_KEY,
  type Appearance,
  type Theme,
} from "@/lib/theme";

type Snapshot = { theme: Theme; resolvedTheme: Appearance };

// Deterministic for both the server render and the hydration pass; the pre-paint
// script has already set the real appearance on <html> by the time this matters.
const SERVER_SNAPSHOT: Snapshot = { theme: "system", resolvedTheme: "light" };

// Referentially stable until the underlying value actually changes, or
// `useSyncExternalStore` re-renders forever.
let cached: Snapshot = SERVER_SNAPSHOT;

function getSnapshot(): Snapshot {
  const theme = readStoredTheme();
  const resolvedTheme = resolveAppearance(theme);

  if (cached.theme !== theme || cached.resolvedTheme !== resolvedTheme) {
    cached = { theme, resolvedTheme };
  }

  return cached;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  const unsubscribe = subscribeToTheme(listener);

  // Follows the OS while the choice is "system".
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onMediaChange = () => {
    if (readStoredTheme() === "system") applyTheme("system");
  };
  media.addEventListener("change", onMediaChange);

  // Another tab wrote the storage key.
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    unsubscribe();
    media.removeEventListener("change", onMediaChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((theme: Theme) => applyTheme(theme), []);

  // Strict Mode's dev-only remount clears the class the pre-paint script set; this
  // is a no-op once the class it applies already matches. Production never remounts.
  useLayoutEffect(() => {
    applyTheme(readStoredTheme());
  }, []);

  return {
    theme: snapshot.theme,
    resolvedTheme: snapshot.resolvedTheme,
    setTheme,
  };
}
