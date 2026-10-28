"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Row, Text } from "@/components/ui";

import { ScheduleSheet } from "./schedule-sheet";

/**
 * A row of a coming week or month: the only act on it is giving it a day, or
 * moving the one it has (RP-142). The row opens `ScheduleSheet`; nothing
 * marks it done here.
 */
export function GiveDayRow({
  oneOffId,
  name,
  meta,
  scheduled,
}: {
  oneOffId: string;
  name: string;
  meta?: string;
  // Set for a task that already has a day: the sheet moves it.
  scheduled?: { day: string; label: string };
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Row
        name={name}
        meta={meta}
        metaVariant="sentence"
        trailing={
          <Text variant="meta" tone="accent">
            {t(scheduled ? "oneOffs.giveDay.move" : "oneOffs.giveDay.give")}
          </Text>
        }
        aria-label={t(scheduled ? "oneOffs.giveDay.moveLabel" : "oneOffs.giveDay.giveLabel", { name })}
        onClick={() => setOpen(true)}
      />
      <ScheduleSheet
        key={scheduled?.day}
        open={open}
        onOpenChange={setOpen}
        oneOffId={oneOffId}
        name={name}
        current={scheduled}
      />
    </>
  );
}
