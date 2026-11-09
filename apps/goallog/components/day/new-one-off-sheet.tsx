"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { AddButton, Sheet } from "@/components/ui";

import { NewOneOff, type NewOneOffProps } from "./new-one-off";

/**
 * The phone's way to write a one-off (RP-154): a «+» fixed over the day that opens the field in a sheet,
 * so it is at the thumb however far the goals run. A write that lands on today closes the sheet on the
 * day it joined; one that goes elsewhere keeps it open on the line that says where.
 */
export function NewOneOffSheet(props: Omit<NewOneOffProps, "onSaved">) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AddButton label={t("day.newOneOff.open")} onClick={() => setOpen(true)} />
      <Sheet open={open} onOpenChange={setOpen} title={t("day.newOneOff.sheetTitle")}>
        <NewOneOff {...props} onSaved={(onToday) => setOpen(!onToday)} />
      </Sheet>
    </>
  );
}
