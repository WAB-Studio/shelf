"use client";

import { useTranslations } from "next-intl";

import { PersonalMark } from "@/components/ui";

/**
 * Another member's personal row wears its owner's name wherever it is listed
 * (RF-58); the caller's own rows and the fund's wear nothing.
 */
export function OwnerMark({
  foreignOwner,
  ownerName,
}: {
  foreignOwner: boolean;
  ownerName: string | null;
}) {
  const t = useTranslations("ownership");

  if (!foreignOwner) return null;

  return (
    <PersonalMark
      showLabel
      label={ownerName ? t("of", { name: ownerName }) : t("ofSomeone")}
    />
  );
}
