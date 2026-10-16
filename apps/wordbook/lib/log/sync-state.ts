import type { SyncState } from "./types";

/** A stored row from before `readerId` and `retired` existed reads as unclaimed and live. */
export function normaliseSyncState(row: unknown): SyncState {
  const stored = (row ?? {}) as Partial<SyncState>;
  return {
    deviceId: stored.deviceId as string,
    pushedThroughLocalId: stored.pushedThroughLocalId ?? null,
    pulledThroughCursor: stored.pulledThroughCursor ?? null,
    lastSyncedAt: stored.lastSyncedAt ?? null,
    enabled: stored.enabled ?? false,
    readerId: stored.readerId ?? null,
    retired: stored.retired ?? false,
  };
}

/** Cursors with no reader recorded were written before the reader was, so they belong to someone else. */
export function isOtherReader(current: SyncState, readerId: string): boolean {
  if (current.readerId !== null) return current.readerId !== readerId;
  return current.pushedThroughLocalId !== null || current.pulledThroughCursor !== null;
}

/**
 * The state a copy for `readerId` starts from. Cursors and `deviceId` belong
 * to one reader on one live device. Another reader starts past
 * `highestLocalId`, so nothing already stored is uploaded for them; a retired
 * device starts over and uploads its own rows again.
 */
export function syncStateForReader(
  current: SyncState,
  readerId: string,
  mintId: () => string,
  highestLocalId: number | null,
): SyncState {
  if (isOtherReader(current, readerId)) {
    return { ...freshSyncState(readerId, mintId), pushedThroughLocalId: highestLocalId };
  }
  if (!current.retired) return { ...current, readerId, enabled: true };
  return freshSyncState(readerId, mintId);
}

function freshSyncState(readerId: string | null, mintId: () => string): SyncState {
  return {
    deviceId: mintId(),
    pushedThroughLocalId: null,
    pulledThroughCursor: null,
    lastSyncedAt: null,
    enabled: true,
    readerId,
    retired: false,
  };
}

/**
 * The state a sign-out leaves behind: the copy off and the reader kept, so
 * the same reader signing back in confirms and carries on. A retired device
 * also drops its identity and cursors, so the next copy starts over.
 */
export function signOutSyncState(current: SyncState, mintId: () => string): SyncState {
  if (!current.retired) return { ...current, enabled: false };
  return { ...freshSyncState(current.readerId, mintId), enabled: false };
}
