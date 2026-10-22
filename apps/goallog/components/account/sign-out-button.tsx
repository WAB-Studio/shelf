"use client";

import { useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { useTranslations } from "next-intl";

import { signOutAction } from "@/app/actions/account";
import { Button, Notice } from "@/components/ui";

// `MetasCerrarSesion` (RP-141): the action redirects, so the button stays on
// «Cerrando…» until the landing; only a failure that is not a redirect frees it, with one line saying so.
export function SignOutButton() {
  const t = useTranslations("account");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      await signOutAction();
    } catch (error) {
      unstable_rethrow(error);
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" block disabled={pending} onClick={signOut}>
        {pending ? t("signingOut") : t("signOut")}
      </Button>
      {failed ? <Notice>{t("signOutFailed")}</Notice> : null}
    </>
  );
}
