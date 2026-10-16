import type { ImportDraft } from "./draft";

const KEY = "pulsar.import-created";

export type FailedKind = "goal" | "phase" | "month" | "commitment" | "task" | "subtask";

// A part the confirm left out, already read against the draft that was sent: the draft is cleared
// the moment the plan is created, so the result cannot look anything up afterwards.
export type CreatedPart = { name: string; goal: string; kind: FailedKind; month: string | null; reason: string };

// What «Plan creado» draws: how many goals were created, how many open goals were updated (RP-130), and each part that was not written.
export type CreatedResult = { goals: number; updated: number; parts: CreatedPart[] };

// The sentence for each reason `FailedPart.reason` can carry; any other key reads as `partFailed`.
export const failedReasonKey: Record<string, string> = {
  "import.errors.cadenceWeekdays": "import.created.reasons.cadenceWeekdays",
  "import.errors.cadenceCount": "import.created.reasons.cadenceCount",
  "import.errors.quantityNoAmount": "import.created.reasons.quantityNoAmount",
  "import.errors.noteShape": "import.created.reasons.noteShape",
  "import.errors.phaseOverlaps": "import.created.reasons.phaseOverlaps",
  "import.errors.partFailed": "import.created.reasons.partFailed",
};

export const reasonSentence = (reason: string): string => failedReasonKey[reason] ?? failedReasonKey["import.errors.partFailed"];

// A failed part's place in the draft that was sent, from the path the confirm names it by.
export function describePart(draft: ImportDraft, failed: { path: string; name: string; reason: string }): CreatedPart {
  const p = failed.path.split(".");
  const goal = draft.goals[Number(p[1])];
  const part = { name: failed.name, goal: goal?.name ?? "", reason: failed.reason };
  if (p[2] === "tasks") {
    const task = goal?.tasks[Number(p[3])];
    return { ...part, kind: p[4] === "children" ? "subtask" : "task", month: task?.month ?? null };
  }
  if (p[2] === "phases") return { ...part, kind: "phase", month: null };
  if (p[2] === "months") return { ...part, kind: "month", month: failed.name };
  if (p[2] === "commitments") return { ...part, kind: "commitment", month: null };
  return { ...part, kind: "goal", month: null };
}

export function saveCreated(result: CreatedResult): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(result));
  } catch {
    // Storage unavailable: the result is lost on reload.
  }
}

const KINDS: readonly string[] = ["goal", "phase", "month", "commitment", "task", "subtask"];

// `null` for nothing stored or anything unreadable.
export function readCreated(): CreatedResult | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { goals?: unknown; updated?: unknown; parts?: unknown };
    if (typeof parsed.goals !== "number" || !Array.isArray(parsed.parts)) return null;
    const parts = parsed.parts.flatMap((entry: Record<string, unknown>): CreatedPart[] =>
      typeof entry?.name === "string" && typeof entry.goal === "string" && typeof entry.reason === "string" && typeof entry.kind === "string" && KINDS.includes(entry.kind)
        ? [{ name: entry.name, goal: entry.goal, kind: entry.kind as FailedKind, month: typeof entry.month === "string" ? entry.month : null, reason: entry.reason }]
        : [],
    );
    return parts.length === 0 ? null : { goals: parsed.goals, updated: typeof parsed.updated === "number" ? parsed.updated : 0, parts };
  } catch {
    return null;
  }
}

export function clearCreated(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
