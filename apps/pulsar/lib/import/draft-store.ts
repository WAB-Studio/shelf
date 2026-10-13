import {
  draftV2Schema,
  importDraftSchema,
  type Correction,
  type ImportDraft,
  type ImportDraftV1,
  type Notice,
  type Source,
} from "./draft";

const KEY = "pulsar.import-draft";

// `source` is the plan's lines, kept for the count (RP-96). `unmarked` is `null` until the review
// first saves, so a fresh draft differs from one the person marked. `declined` holds correction ids.
export type StoredDraft = {
  version: 2;
  via: "template" | "workbook" | "model";
  draft: ImportDraft;
  corrections: Correction[];
  notices: Notice[];
  source: Source;
  sourceName: string | null;
  // The text as the person wrote it, for the box and the review's left column; `source.lines`
  // is the reader's own cut (a template's note lines lose their prefix).
  text?: string | null;
  unmarked: string[] | null;
  declined: string[];
};

// The draft rides from the import screen to its review in the tab's own storage: a reload of the
// review keeps it, a new tab starts without it, and nothing reaches the database before the confirm.
export function saveDraft(input: {
  via: StoredDraft["via"];
  draft: ImportDraft;
  corrections: Correction[];
  notices: Notice[];
  source: Source;
  sourceName?: string | null;
  text?: string | null;
}): void {
  write({ version: 2, ...input, sourceName: input.sourceName ?? null, text: input.text ?? null, unmarked: null, declined: [] });
}

// Rewrites the draft, the unmarked paths and the declined corrections, and the corrections themselves when
// given (an edit settles some); the rest stays.
export function saveReview(draft: ImportDraft, unmarked: string[], declined: string[], corrections?: Correction[]): void {
  const current = readDraft();
  if (!current) return;
  write({ ...current, draft, unmarked, declined, ...(corrections ? { corrections } : {}) });
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : []);
const records = <T>(value: unknown): T[] => (Array.isArray(value) ? value.filter((p): p is T => typeof p === "object" && p !== null) : []);

// `null` for nothing stored, anything unreadable, a version other than 2, or a draft the schema refuses.
export function readDraft(): StoredDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.version !== 2) return null;
    if (parsed.via !== "template" && parsed.via !== "workbook" && parsed.via !== "model") return null;
    const draft = draftV2Schema.safeParse(parsed.draft);
    if (!draft.success) return null;
    const source = parsed.source as { kind?: unknown; lines?: unknown } | null;
    if (source === null || typeof source !== "object") return null;
    if (source.kind !== "lines" && source.kind !== "rows" && source.kind !== "parts") return null;
    if (source.lines !== null && !Array.isArray(source.lines)) return null;
    return {
      version: 2,
      via: parsed.via,
      draft: draft.data,
      corrections: records<Correction>(parsed.corrections),
      notices: records<Notice>(parsed.notices),
      source: { kind: source.kind, lines: source.lines === null ? null : strings(source.lines) },
      sourceName: typeof parsed.sourceName === "string" ? parsed.sourceName : null,
      text: typeof parsed.text === "string" ? parsed.text : parsed.text === null ? null : undefined,
      unmarked: Array.isArray(parsed.unmarked) ? strings(parsed.unmarked) : null,
      declined: strings(parsed.declined),
    };
  } catch {
    return null;
  }
}

// The text the person wrote: kept whole when the draft was read from one; `null` for a file
// (the name stands in); a draft stored without it falls back to the reader's own lines.
export function storedText(stored: StoredDraft): string | null {
  if (stored.text !== undefined) return stored.text;
  return stored.source.kind === "lines" && stored.source.lines !== null ? stored.source.lines.join("\n") : null;
}

// What the box holds when the person comes back to it.
export function readText(): string | null {
  const stored = readDraft();
  return stored ? storedText(stored) : null;
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

function write(stored: StoredDraft | StoredDraftV1): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable: the review finds no draft and sends the person back.
  }
}

// ---- The version 1 shape the import and review screens still use, until 885 and 886 move them.

export type StoredDraftV1 = {
  via: "template" | "model";
  draft: ImportDraftV1;
  source: string | null;
  sourceName: string | null;
  unmarked: string[] | null;
};

export function saveDraftV1(input: { via: StoredDraftV1["via"]; draft: ImportDraftV1; source?: string | null; sourceName?: string | null }): void {
  write({
    via: input.via,
    draft: input.draft,
    source: input.source ?? null,
    sourceName: input.sourceName ?? null,
    unmarked: null,
  });
}

export function saveReviewV1(draft: ImportDraftV1, unmarked: string[]): void {
  const current = readDraftV1();
  if (!current) return;
  write({ ...current, draft, unmarked });
}

export function readDraftV1(): StoredDraftV1 | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { via?: unknown; draft?: unknown; source?: unknown; sourceName?: unknown; unmarked?: unknown };
    if (parsed.via !== "template" && parsed.via !== "model") return null;
    const draft = importDraftSchema.safeParse(parsed.draft);
    if (!draft.success) return null;
    return {
      via: parsed.via,
      draft: draft.data,
      source: typeof parsed.source === "string" ? parsed.source : null,
      sourceName: typeof parsed.sourceName === "string" ? parsed.sourceName : null,
      unmarked: Array.isArray(parsed.unmarked)
        ? parsed.unmarked.filter((p): p is string => typeof p === "string")
        : null,
    };
  } catch {
    return null;
  }
}

export function readSourceV1(): string | null {
  return readDraftV1()?.source ?? null;
}
