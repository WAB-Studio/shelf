"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { LOG_DELETED_EVENT } from "@/lib/log/delete";
import { LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT } from "@/lib/log/record";
import { readWordStudy } from "@/lib/log/summary";
import { buildQueue } from "@/lib/review/deck";
import { readCards } from "@/lib/review/store";
import { SYNC_LANDED_EVENT } from "@/lib/sync/driver";
import { Button } from "@/components/ui";

// The way into the review, named for how many entries wait today. Draws nothing until the record is
// read, and nothing when none is due: a button that opens an empty session is not a way in.
export function ReviewLink() {
  const t = useTranslations("review");
  const [due, setDue] = useState(0);

  useEffect(() => {
    let live = true;
    function read(): void {
      Promise.all([readWordStudy(), readCards()])
        .then(([{ rows }, cards]) => {
          if (live) setDue(buildQueue(rows, cards, Date.now()).items.length);
        })
        .catch(() => {});
    }
    read();
    // A deleted row or a wipe changes what is due without a reload.
    const events = [LOG_DELETED_EVENT, LOG_CLEARED_EVENT, LOG_FLUSHED_EVENT, SYNC_LANDED_EVENT];
    for (const name of events) window.addEventListener(name, read);
    return () => {
      live = false;
      for (const name of events) window.removeEventListener(name, read);
    };
  }, []);

  if (due === 0) return null;

  return (
    <Button asChild size="3">
      <NextLink href="/repaso" prefetch={false}>{t("openCount", { count: due })}</NextLink>
    </Button>
  );
}
