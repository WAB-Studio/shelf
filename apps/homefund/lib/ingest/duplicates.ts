import { readAccountTails } from "@/lib/transactions/interpret";

// RF-208: one payment can reach the inbox as a bank or wallet alert (the primary) and as the notices it
// leaves behind: PSE's, a payment gateway's, a merchant's receipt. The same alert can also arrive through
// two channels, the phone's SMS or notification and the bank's email. Pure: candidates in, verdict out.

// Days either side of a delivery in which another with the same figure reports the same payment.
export const DUPLICATE_WINDOW_DAYS = 2;

// Minutes either side of an alert in which the same alert through the other channel is the same movement.
export const CHANNEL_WINDOW_MINUTES = 30;

export type DuplicateCandidate = {
  id: string;
  // Where it arrived: the bank's email, or the phone (SMS, notification, shortcut).
  fromEmail: boolean;
  rawText: string;
  occurredOn: string | null;
  // When it reached the inbox, in milliseconds.
  receivedAt: number;
  status: "pending" | "accepted";
  receipt: boolean;
  shapeHash: string;
  direction: "income" | "expense" | "transfer" | null;
  merchantKey: string | null;
  merchantLabel: string | null;
};

export type DuplicateFacts = {
  fromEmail: boolean;
  text: string;
  occurredOn: string;
  receivedAt: number;
  receipt: boolean;
  shapeHash: string;
  direction: "income" | "expense" | "transfer" | null;
};

export type DuplicateVerdict =
  | { kind: "none" }
  // The new delivery repeats `of`: it lands rejected as «duplicate», linked to it.
  | { kind: "repeats"; of: DuplicateCandidate }
  // The new alert replaces receipts still waiting: they become its duplicates.
  | { kind: "supersedes"; pending: DuplicateCandidate[] };

// An income and an expense of one figure are two movements, not one payment seen twice.
function sameDirection(a: DuplicateFacts["direction"], b: DuplicateCandidate["direction"]): boolean {
  return a === null || b === null || a === "transfer" || b === "transfer" || a === b;
}

// The time of day a bank prints in its alert, in minutes: «a las 17:03», «31/08/2026 20:44:43».
const CLOCK = /(?:\ba las\s+|\d{4}\s+|\/\d{2}\s+)(\d{1,2}):(\d{2})(?::\d{2})?\b/;

function clockOf(text: string): number | null {
  const match = CLOCK.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// The tails each text gives for the person's own account; a text that gives none agrees with any.
function tailsAgree(a: string, b: string, direction: DuplicateFacts["direction"]): boolean {
  const side = direction === "transfer" ? null : direction;
  const first = readAccountTails(a, side);
  const second = readAccountTails(b, side);
  return first.size === 0 || second.size === 0 || [...first].some((tail) => second.has(tail));
}

// Two alerts are close when the times of day they print are within the window on the same day; an alert
// that prints none is placed by when it arrived.
function closeInTime(fresh: DuplicateFacts, candidate: DuplicateCandidate): boolean {
  const window = CHANNEL_WINDOW_MINUTES;
  const printed = [clockOf(fresh.text), clockOf(candidate.rawText)];
  if (printed[0] !== null && printed[1] !== null && candidate.occurredOn === fresh.occurredOn) {
    return Math.abs(printed[0] - printed[1]) <= window;
  }
  return Math.abs(fresh.receivedAt - candidate.receivedAt) <= window * 60_000;
}

// The same alert through the other channel: another primary, same figure, a tail that does not contradict.
function sameAlertOtherChannel(fresh: DuplicateFacts, candidate: DuplicateCandidate): boolean {
  return (
    !candidate.receipt &&
    candidate.fromEmail !== fresh.fromEmail &&
    closeInTime(fresh, candidate) &&
    tailsAgree(fresh.text, candidate.rawText, fresh.direction ?? candidate.direction)
  );
}

// A decided delivery (its movement exists) is the better original, then the oldest waiting one.
function preferred(candidates: DuplicateCandidate[]): DuplicateCandidate | undefined {
  return candidates.find((candidate) => candidate.status === "accepted") ?? candidates[0];
}

/**
 * Whether a delivery repeats a payment the inbox already knows. A receipt repeats an alert; when no
 * alert exists it repeats another receipt of a different template (the same template twice is two
 * payments). An alert repeats an alert only from the other channel within the window (the same channel
 * twice is two purchases); it replaces the receipts still waiting, unless one was already accepted,
 * which makes the alert the repeat. `candidates` come oldest first, already
 * limited to the same owner, figure (or merchant when there is no figure) and days.
 */
export function judgeDuplicate(fresh: DuplicateFacts, candidates: DuplicateCandidate[]): DuplicateVerdict {
  const comparable = candidates.filter((candidate) => sameDirection(fresh.direction, candidate.direction));

  if (fresh.receipt) {
    const original =
      preferred(comparable.filter((candidate) => !candidate.receipt)) ??
      preferred(comparable.filter((candidate) => candidate.receipt && candidate.shapeHash !== fresh.shapeHash));
    return original ? { kind: "repeats", of: original } : { kind: "none" };
  }

  const otherChannel = preferred(comparable.filter((candidate) => sameAlertOtherChannel(fresh, candidate)));
  if (otherChannel) return { kind: "repeats", of: otherChannel };

  const receipts = comparable.filter((candidate) => candidate.receipt);
  const accepted = receipts.find((candidate) => candidate.status === "accepted");
  if (accepted) return { kind: "repeats", of: accepted };

  return receipts.length > 0 ? { kind: "supersedes", pending: receipts } : { kind: "none" };
}
