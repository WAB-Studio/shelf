// RF-208: one payment can reach the inbox as a bank or wallet alert (the primary) and as the notices it
// leaves behind: PSE's, a payment gateway's, a merchant's receipt. Pure: candidates in, verdict out.

// Days either side of a delivery in which another with the same figure reports the same payment.
export const DUPLICATE_WINDOW_DAYS = 2;

export type DuplicateCandidate = {
  id: string;
  status: "pending" | "accepted";
  receipt: boolean;
  shapeHash: string;
  direction: "income" | "expense" | "transfer" | null;
  merchantKey: string | null;
  merchantLabel: string | null;
};

export type DuplicateFacts = {
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

// A decided delivery (its movement exists) is the better original, then the oldest waiting one.
function preferred(candidates: DuplicateCandidate[]): DuplicateCandidate | undefined {
  return candidates.find((candidate) => candidate.status === "accepted") ?? candidates[0];
}

/**
 * Whether a bank email repeats a payment the inbox already knows. A receipt repeats an alert; when no
 * alert exists it repeats another receipt of a different template (the same template twice is two
 * payments). An alert never repeats an alert, and it replaces the receipts still waiting, unless one
 * was already accepted, which makes the alert the repeat. `candidates` come oldest first, already
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

  const receipts = comparable.filter((candidate) => candidate.receipt);
  const accepted = receipts.find((candidate) => candidate.status === "accepted");
  if (accepted) return { kind: "repeats", of: accepted };

  return receipts.length > 0 ? { kind: "supersedes", pending: receipts } : { kind: "none" };
}
