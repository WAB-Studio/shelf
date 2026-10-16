import type { TranslatorInstance } from "./translator-api";
import type { TranslationResult } from "./types";

// The one instance the page keeps once it exists, per `enableDeviceTranslator`
// below. Not touched by `translateOnDevice`, which only ever reads it.
let translator: TranslatorInstance | undefined;

export class TranslatorNotReadyError extends Error {
  constructor() {
    super("No on-device translator has been created yet");
    this.name = "TranslatorNotReadyError";
  }
}

// Safe to call from a debounced keystroke: it never asks the browser to
// create anything, so it never starts a download. When no translator exists
// yet it rejects instead of falling silent, so the caller falls back to the
// network path (RL-09) rather than losing the sentence.
export async function translateOnDevice(
  text: string,
  options?: { signal?: AbortSignal },
): Promise<TranslationResult> {
  if (!translator) {
    throw new TranslatorNotReadyError();
  }
  options?.signal?.throwIfAborted();

  const translated = await translator.translate(text, options);
  return { text: translated, origin: "device" };
}

// The only call in this app that may create the translator, and the only one
// that may need a download it did not ask to start. RL-11: when the model
// is merely "downloadable", creating it is what starts the download, so this
// must run from a user gesture — a click handler, never a debounce timer.
// The one exception is a translator that is already "available": creating it
// then costs nothing to download, which is why the screen also calls this
// once on mount to pick it up with no gesture required.
export async function enableDeviceTranslator(options?: {
  onDownloadProgress?: (fraction: number | null) => void;
}): Promise<void> {
  if (typeof Translator === "undefined") {
    throw new Error("Translator is not supported in this browser");
  }

  translator = await Translator.create({
    sourceLanguage: "en",
    targetLanguage: "es",
    monitor(monitor) {
      try {
        monitor.addEventListener("downloadprogress", (event) => {
          const fraction = typeof event.loaded === "number" ? event.loaded : null;
          options?.onDownloadProgress?.(fraction);
        });
      } catch {
        // A monitor shape that does not support this: progress goes
        // unreported, but the download and the translator still proceed.
      }
    },
  });
}
