"use client";

import { TimerIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";

import { setKeepSignedInAction } from "@/app/actions/session";
import { type Responsive, Select, Spinner, ToolbarSelect } from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { isKeepSignedInChoice, KEEP_SIGNED_IN_CHOICES } from "@/lib/validation/session";

/**
 * «Mantener la sesión abierta» (RF-190): the days a device may sit unused before it is signed out.
 * `saved` is the stored value; one nobody offers is shown as its own number.
 */
export function KeepSignedInSelect({ saved, width }: { saved: string; width?: Responsive<string> }) {
  const t = useTranslations("session");
  const errorToast = useActionErrorToast();
  // The pick while the action runs, tied to the value it was made over: once `saved` moves, the pick is void.
  const [picked, setPicked] = useState<{ over: string; value: string } | null>(null);
  const choice = picked?.over === saved ? picked.value : saved;

  const { execute, isPending } = useAction(setKeepSignedInAction, {
    onError(args) {
      setPicked(null);
      errorToast(args);
    },
  });

  function onValueChange(value: string) {
    if (!isKeepSignedInChoice(value)) return;
    setPicked({ over: saved, value });
    execute({ days: value });
  }

  const text = (option: string) => (option === "always" ? t("always") : t("afterDays", { count: Number(option) }));
  const options = isKeepSignedInChoice(saved) ? KEEP_SIGNED_IN_CHOICES : [...KEEP_SIGNED_IN_CHOICES, saved];

  return (
    <ToolbarSelect
      value={choice}
      onValueChange={onValueChange}
      disabled={isPending}
      label={t("label")}
      icon={isPending ? <Spinner /> : <TimerIcon size={16} />}
      text={text(choice)}
      width={width}
      showText
    >
      {options.map((option) => (
        <Select.Item key={option} value={option}>
          {text(option)}
        </Select.Item>
      ))}
    </ToolbarSelect>
  );
}
