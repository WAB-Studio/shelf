"use client";

import { useEffect } from "react";

import { LOG_DELETED_EVENT, readTombstoneQueue } from "@/lib/log/delete";
import { readSyncState } from "@/lib/log/record";
import { syncNow } from "@/lib/sync/driver";

/**
 * Renders nothing. Sends a delete's marks in a round of its own (RNL-11).
 * `syncNow()` answers `off` without a request when the copy is off. A call
 * that shared a round already in flight may have missed the new marks, so
 * one follow-up runs while any are still queued. Never a timer.
 */
export function SyncOnDelete() {
  useEffect(() => {
    async function onDeleted(): Promise<void> {
      const outcome = await syncNow();
      if (outcome.kind !== "done") return;
      const { readerId } = await readSyncState();
      if (readerId === null) return;
      const { pending } = await readTombstoneQueue(readerId);
      if (pending.length > 0) await syncNow();
    }

    const listener = () => void onDeleted();
    window.addEventListener(LOG_DELETED_EVENT, listener);
    return () => window.removeEventListener(LOG_DELETED_EVENT, listener);
  }, []);

  return null;
}
