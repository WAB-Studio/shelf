// RF-188: Safari on an iPhone or iPad offers no install prompt, so the app explains the
// Share sheet once, until dismissed. Storage is touched here and nowhere else.
const STORAGE_KEY = "install-hint-dismissed";

const listeners = new Set<() => void>();

// Chrome, Firefox, Edge, Opera and the in-app browsers of iOS name themselves; Safari does not.
const OTHER_IOS_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\//;

/** iOS Safari in a tab: an iPhone, an iPod, or an iPad that reports itself as a Mac. */
export function isIosSafariTab(
  userAgent: string,
  standalone: boolean | undefined,
  maxTouchPoints: number,
): boolean {
  if (standalone === true) return false;
  const ios =
    /iPhone|iPod|iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && /Safari\//.test(userAgent) && !OTHER_IOS_BROWSER.test(userAgent);
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function readInstallHintShown(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return isIosSafariTab(nav.userAgent, nav.standalone, nav.maxTouchPoints) && !readDismissed();
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage unavailable; the hint stays away for this page's life only.
  }
  for (const listener of listeners) listener();
}

export function subscribeToInstallHint(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
