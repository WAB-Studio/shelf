// RNL-07: the reader's light or dark, kept on this device. Until one is chosen the system's mode
// decides, through `prefers-color-scheme` in app/theme.css; a choice is `data-theme` on <html>.
export type ThemeChoice = "light" | "dark";

const KEY = "wordbook.theme";
const CHANGED = "wordbook:theme";

// Runs in <head> before the first paint, so a chosen mode never flashes the other one.
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function chooseTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Storage refused: the choice holds for this visit only.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function currentTheme(): ThemeChoice {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Another tab's choice arrives as a `storage` event and is applied here too: the choice is the device's.
export function subscribeTheme(onChange: () => void): () => void {
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key !== KEY || (event.newValue !== "light" && event.newValue !== "dark")) return;
    document.documentElement.dataset.theme = event.newValue;
    onChange();
  };
  system.addEventListener("change", onChange);
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", fromOtherTab);
  return () => {
    system.removeEventListener("change", onChange);
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", fromOtherTab);
  };
}
