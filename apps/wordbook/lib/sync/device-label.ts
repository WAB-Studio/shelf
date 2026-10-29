// The label a device is stored under: two codes, never words. The server has
// no language; the account screen translates `chrome` and `android` itself
// (RNL-02). Coarse on purpose — browser family and platform, nothing that
// adds entropy a fingerprint would.

// Order matters: Samsung Internet, Edge and Opera also say "Chrome", Chrome also says "Safari".
function browserCode(userAgent: string): string {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/OPR\/|Opera/.test(userAgent)) return "opera";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "firefox";
  if (/SamsungBrowser\//.test(userAgent)) return "samsung";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "chrome";
  if (/Safari\//.test(userAgent)) return "safari";
  return "other";
}

// Android, iPadOS and iOS first: their user-agents also name Linux and Mac OS X.
function platformCode(userAgent: string): string {
  if (/Android/.test(userAgent)) return "android";
  if (/iPad/.test(userAgent)) return "ipados";
  if (/iPhone|iPod/.test(userAgent)) return "ios";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Mac OS X/.test(userAgent)) return "macos";
  if (/Linux/.test(userAgent)) return "linux";
  return "other";
}

export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return "unknown:unknown";
  return `${browserCode(userAgent)}:${platformCode(userAgent)}`;
}
