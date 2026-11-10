"use client";

import { useTranslations } from "next-intl";

import { PersonalMark } from "@/components/ui";

/**
 * How another member's name reads where a row is theirs («De Andrea»): the one
 * place the wording is chosen, whether the row writes it as a label or as a mark.
 */
export function useOwnerLabel(): (ownerName: string | null) => string {
  const t = useTranslations("ownership");

  return (ownerName) => (ownerName ? t("of", { name: ownerName }) : t("ofSomeone"));
}

/**
 * Another member's personal row wears its owner's name wherever it is listed
 * (RF-58). The caller's own personal row (`personal`) wears the bare glyph, and
 * the fund's wears nothing.
 */
export function OwnerMark({
  foreignOwner,
  ownerName,
  personal = false,
}: {
  foreignOwner: boolean;
  ownerName: string | null;
  personal?: boolean;
}) {
  const t = useTranslations("accounts");
  const ownerLabel = useOwnerLabel();

  if (foreignOwner) return <PersonalMark showLabel label={ownerLabel(ownerName)} />;
  if (personal) return <PersonalMark label={t("ownerPersonal")} />;

  return null;
}
