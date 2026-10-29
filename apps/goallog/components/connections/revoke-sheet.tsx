"use client";

import { useTranslations } from "next-intl";

import { Button, Sheet, SheetActions } from "@/components/ui";

export type RevokeSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  kind: "personal" | "oauth";
  onConfirm: () => void;
  busy: boolean;
};

/**
 * `ConexionesRevocar.dc.html` (RP-38): a revoke cannot be undone, so the row's
 * button only asks. Only the confirmation calls `onConfirm`.
 */
export function RevokeSheet({ open, onOpenChange, name, kind, onConfirm, busy }: RevokeSheetProps) {
  const t = useTranslations("connections.revokeSheet");
  const oauth = kind === "oauth";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      label={t(oauth ? "oauthLabel" : "keyLabel")}
      title={t("title", { name })}
      description={t(oauth ? "oauthBody" : "keyBody")}
    >
      <SheetActions>
        <Button tap={52} block onClick={onConfirm} disabled={busy}>
          {t("confirm")}
        </Button>
        <Button variant="outline" tap={52} block onClick={() => onOpenChange(false)} disabled={busy}>
          {t("cancel")}
        </Button>
      </SheetActions>
    </Sheet>
  );
}
