"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { contentUnit } from "@/lib/log/outcome";
import { readWordStudy } from "@/lib/log/summary";
import { isReviewable } from "@/lib/review/deck";
import { Button } from "@/components/ui";

// The way into the review, named for what it will ask: words, phrases, or entries once both are
// among the reviewable rows. Plain «Repasar» until the record is read.
export function ReviewLink() {
  const t = useTranslations("review");
  const [unit, setUnit] = useState<"words" | "phrases" | "entries" | null>(null);

  useEffect(() => {
    let live = true;
    readWordStudy()
      .then(({ rows }) => {
        if (live) setUnit(contentUnit(rows.filter(isReviewable)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <Button asChild size="3" variant="soft">
      <NextLink href="/repaso">{unit === null ? t("open") : t("openKind", { kind: unit })}</NextLink>
    </Button>
  );
}
