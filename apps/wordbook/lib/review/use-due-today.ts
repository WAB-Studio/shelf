"use client";

import { useEffect, useState } from "react";

import { contentUnit } from "@/lib/log/outcome";
import { onRecordChanged } from "@/lib/log/record-changed";
import { readWordStudy } from "@/lib/log/summary";
import { buildQueue, isReviewable } from "./deck";
import { readCards } from "./store";

export type DueToday = { due: number; unit: "words" | "phrases" | "entries" };

// What waits in the review today, read from the device's record and kept current as it changes. `null`
// until the first read and for a record with nothing to review, or when the read fails: one rule for
// every screen that offers the way in. An event during a read queues a single rerun, never a second pass.
export function useDueToday(): DueToday | null {
  const [due, setDue] = useState<DueToday | null>(null);

  useEffect(() => {
    let live = true;
    let reading = false;
    let rerun = false;

    function read(): void {
      if (reading) {
        rerun = true;
        return;
      }
      reading = true;
      Promise.all([readWordStudy(), readCards()])
        .then(([{ rows }, cards]) => {
          if (!live) return;
          const reviewable = rows.filter(isReviewable);
          setDue(
            reviewable.length === 0
              ? null
              : { due: buildQueue(rows, cards, Date.now()).items.length, unit: contentUnit(reviewable) },
          );
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
          if (live && rerun) {
            rerun = false;
            read();
          }
        });
    }

    read();
    const off = onRecordChanged(read);
    return () => {
      live = false;
      off();
    };
  }, []);

  return due;
}
