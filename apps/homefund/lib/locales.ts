// Adding a language costs exactly two things:
// 1. Add `messages/<locale>.json`, mirroring the key set — typecheck enforces it.
// 2. Add the code to `LOCALES`.
// No migration follows: the stored locale is `text`, with no Postgres enum and no
// check constraint. `defineRouting`, `generateStaticParams`, the validation schema,
// the proxy matcher and the language switcher all read `LOCALES`.
// What this does not cover: Supabase holds one auth email template per project, so
// authentication emails stay in a single language.

export const LOCALES = ["es", "en"] as const;

export const DEFAULT_LOCALE = "es";

export type Locale = (typeof LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return LOCALES.includes(value as Locale);
}

export const TIME_ZONE = "America/Bogota";

// The region a language resolves its figures in. Plain `es` writes "1050 COP";
// the fund books in Bogota, and `es-CO` writes "$ 1.050". Only a formatter
// reads this: the URL segment, the messages and every link stay the language.
export const FORMAT_LOCALE = {
  es: "es-CO",
  en: "en",
} as const satisfies Record<Locale, string>;
