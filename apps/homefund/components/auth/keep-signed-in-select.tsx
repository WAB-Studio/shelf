"use client";

import { TimerIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";

import { setKeepSignedInAction } from "@/app/actions/session";
import { type Responsive, Select, Spinner, ToolbarSelect } from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { KEEP_SIGNED_IN_CHOICES, type KeepSignedInChoice } from "@/lib/validation/session";

function isChoice(value: string): value is KeepSignedInChoice {
  return (KEEP_SIGNED_IN_CHOICES as readonly string[]).includes(value);
}

/** «Mantener la sesión abierta» (RF-190): the days a device may sit unused before it is signed out. */
export function KeepSignedInSelect({
  choice: saved,
  width,
}: {
  choice: KeepSignedInChoice;
  width?: Responsive<string>;
}) {
  const t = useTranslations("session");
  const errorToast = useActionErrorToast();
  // Holds the pick while the action runs, so the control does not snap back to the old value.
  const [choice, setChoice] = useState(saved);

  const { execute, isPending } = useAction(setKeepSignedInAction, {
    onError(args) {
      setChoice(saved);
      errorToast(args);
    },
  });

  function onValueChange(value: string) {
    if (!isChoice(value)) return;
    setChoice(value);
    execute({ days: value });
  }

  const text = (option: KeepSignedInChoice) =>
    option === "always" ? t("always") : t("afterDays", { count: Number(option) });

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
      {KEEP_SIGNED_IN_CHOICES.map((option) => (
        <Select.Item key={option} value={option}>
          {text(option)}
        </Select.Item>
      ))}
    </ToolbarSelect>
  );
}
