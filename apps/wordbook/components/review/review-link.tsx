"use client";

import NextLink from "next/link";
import { useTranslations } from "next-intl";

import { useDueToday } from "@/lib/review/use-due-today";
import { Button } from "@/components/ui";

// The way into the review, named for how many entries wait today. Draws nothing until the record is
// read, and nothing when none is due: a button that opens an empty session is not a way in.
export function ReviewLink() {
  const t = useTranslations("review");
  const due = useDueToday();

  if (due === null || due.due === 0) return null;

  return (
    <Button asChild size="3">
      <NextLink href="/repaso" prefetch={false}>{t("openCount", { count: due.due })}</NextLink>
    </Button>
  );
}
