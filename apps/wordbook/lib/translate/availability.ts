// Asks the browser, on every open, whether it offers a translator (RL-08).
// Nothing here is memoized: a module-level cache would answer a later open
// with a stale value, which is exactly what RL-08 rules out.

export type TranslatorState =
  | "unsupported"
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

const LANGUAGES = { sourceLanguage: "en", targetLanguage: "es" } as const;

export async function deviceTranslatorState(): Promise<TranslatorState> {
  // `globalThis`, not `window`: this reads the same in a worker as on the
  // main thread, and neither insecure nor absent should ever throw.
  if (!globalThis.isSecureContext) return "unsupported";
  if (typeof Translator === "undefined") return "unsupported";

  try {
    const availability = await Translator.availability(LANGUAGES);
    switch (availability) {
      case "unavailable":
      case "downloadable":
      case "downloading":
      case "available":
        return availability;
      default:
        // A future browser reporting a value this file does not know: treat
        // it as no capability rather than trust a shape it never asked for.
        return "unsupported";
    }
  } catch {
    return "unsupported";
  }
}
