"use client";

import { useEffect } from "react";

import { syncNow } from "@/lib/sync/driver";

/** Renders nothing. Fires one `syncNow()` per mount (RNL-09); it answers `off` without a request when the copy is off or retired. */
export function SyncOnOpen() {
  useEffect(() => {
    void syncNow();
  }, []);

  return null;
}
