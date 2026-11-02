import { useSyncExternalStore } from "react";

const TWO_PANELS = "(min-width: 1280px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(TWO_PANELS);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

// True from 1280px, where `Panels` draws its second panel. False on the server and until hydration.
export function useWideScreen(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(TWO_PANELS).matches, () => false);
}
