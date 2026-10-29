import type { MessageKey, SourceKey } from "@/i18n/translator";

/**
 * The translator surface this needs, narrow enough that a test passes a
 * plain object and a screen passes next-intl's own.
 */
export type UnitTranslator = {
  (key: MessageKey, values: { count: number }): string;
  has(key: MessageKey): boolean;
};

/**
 * An evidence source's unit as a Spanish noun (RP-09, RNP-10). The words
 * live in `messages/es/sources.json` under the source's own `labelKey` plus
 * `Unit`, so a second source names its unit there and no component changes.
 * A source with no words yet reads as its raw unit, never as a missing key.
 */
export function evidenceUnitWords(
  source: { labelKey: SourceKey; unit: string },
  count: number,
  t: UnitTranslator,
): string {
  const key: MessageKey = `${source.labelKey}Unit`;
  return t.has(key) ? t(key, { count }) : source.unit;
}
