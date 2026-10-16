import type { LookupRecord } from "@/lib/log/types";
import { syncRowSchema, type SyncRow } from "./protocol";

// The wire's own limits, read off the schema: a row recorded before the
// recording clamp existed still has to fit.
const TEXT_MAX = syncRowSchema.shape.text.maxLength!;
const NORMALISED_MAX = syncRowSchema.shape.normalised.maxLength!;
const HEADWORD_MAX = syncRowSchema.shape.headword.unwrap().maxLength!;
const ANSWER_MAX = syncRowSchema.shape.definition.unwrap().unwrap().maxLength!;

function cutAnswer(value: string | null | undefined): string | null {
  return value == null ? null : cut(value, ANSWER_MAX);
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

function toSyncRow(row: LookupRecord, deviceId: string): SyncRow {
  return {
    deviceId,
    localId: row.id!,
    at: row.at,
    text: cut(row.text, TEXT_MAX),
    normalised: cut(row.normalised, NORMALISED_MAX),
    kind: row.kind,
    outcome: row.outcome,
    headword: row.headword === null ? null : cut(row.headword, HEADWORD_MAX),
    rule: row.rule,
    senses: row.senses,
    translation: row.translation,
    definition: cutAnswer(row.definition),
    exampleEn: cutAnswer(row.exampleEn),
    exampleEs: cutAnswer(row.exampleEs),
    dictionaryReady: row.dictionaryReady,
    origin: row.origin,
    recordSchema: row.schema,
  };
}

/**
 * One upload page: the local rows, cut to what the wire admits.
 */
export function planUploadRound(
  scanned: LookupRecord[],
  deviceId: string,
): { rows: SyncRow[] } {
  return {
    rows: scanned.filter((row) => row.device == null).map((row) => toSyncRow(row, deviceId)),
  };
}
