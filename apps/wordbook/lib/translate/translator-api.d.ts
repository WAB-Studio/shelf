// Ambient shape of Chrome's on-device Translator API
// (https://developer.chrome.com/docs/ai/translator-api). It is not part of
// TypeScript's own DOM lib.
//
// This declares the documented surface, not one read off a running browser:
// a probe of this repo's own Playwright Chromium (open-source Chromium,
// carrying none of Google's on-device model components) found the global
// absent entirely — `typeof Translator === "undefined"` there, same as on
// any other browser that offers no translator. Nothing in `lib/translate`
// assumes this shape holds; every call onto it is wrapped so a mismatch
// degrades to `"unsupported"` (see `availability.ts`) instead of throwing.
//
// Declared as narrowly as `availability.ts` and `on-device.ts` use it: the
// two calls the flows need, `availability()` and `create()`, the one method
// an instance offers, `translate()`, and the one event the download monitor
// reports, `downloadprogress`.

export type TranslatorAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export interface TranslatorLanguageOptions {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TranslatorDownloadProgressEvent extends Event {
  readonly loaded: number;
}

export interface TranslatorMonitor extends EventTarget {
  addEventListener(
    type: "downloadprogress",
    listener: (event: TranslatorDownloadProgressEvent) => void,
  ): void;
}

export interface TranslatorCreateOptions extends TranslatorLanguageOptions {
  monitor?(monitor: TranslatorMonitor): void;
}

export interface TranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
}

declare global {
  interface TranslatorStatic {
    availability(
      options: TranslatorLanguageOptions,
    ): Promise<TranslatorAvailability>;
    create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
  }

  // A `var` is what `declare global` accepts for an ambient value: the
  // global may not exist at all, which is the fact this whole module exists
  // to ask about, so every reference to it must go through `typeof`.
  var Translator: TranslatorStatic | undefined;
}
