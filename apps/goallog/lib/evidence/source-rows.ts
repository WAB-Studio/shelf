import type { SourceKey } from "@/i18n/translator";

import { TIMELOG_SOURCES, TIMELOG_UNIT } from "./timelog-apps";


/**
 * Every `goals.evidence_sources` row the app declares, next to the readers
 * in `registry.ts`. `npm run source:add` upserts these; a second source is
 * one entry here, one reader there and two keys in `messages/es/sources.json`
 * (`<name>` and `<name>Unit`), never a migration (RNP-10).
 */
export type EvidenceSourceRow = {
  key: string;
  labelKey: SourceKey;
  unit: string;
};

export const SOURCE_ROWS: readonly EvidenceSourceRow[] = [
  { key: "reading_lookups", labelKey: "sources.readingLookups", unit: "searches" },
  ...TIMELOG_SOURCES.map((source) => ({ key: source.key, labelKey: source.labelKey, unit: TIMELOG_UNIT })),
];
