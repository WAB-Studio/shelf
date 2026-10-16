"use client";

import { LanguagesIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";

import { setLocaleAction } from "@/app/actions/locale";
import { type Responsive, Select, Spinner, ToolbarSelect } from "@/components/ui";
import { usePathname } from "@/i18n/navigation";
import { isLocale, LOCALES } from "@/lib/locales";
import { useActionErrorToast } from "@/lib/use-action-toast";

export function LanguageSwitcher({ width }: { width?: Responsive<string> }) {
  const t = useTranslations("language");
  const locale = useLocale();
  const pathname = usePathname();
  // Never cleared: the document is leaving, and the control must not come back
  // to life in the gap between the action resolving and the new page painting.
  const [leaving, setLeaving] = useState(false);

  const { execute, isPending } = useAction(setLocaleAction, {
    // A document navigation, never a client one: only a full load re-runs the pre-paint theme script.
    onSuccess({ data }) {
      setLeaving(true);
      window.location.assign(
        new URL(`/${data.locale}${pathname}`, window.location.origin),
      );
    },
    onError: useActionErrorToast(),
  });

  function onValueChange(value: string) {
    if (isLocale(value)) execute({ locale: value });
  }

  const pending = isPending || leaving;

  return (
    <ToolbarSelect
      value={locale}
      onValueChange={onValueChange}
      disabled={pending}
      label={t("label")}
      icon={pending ? <Spinner /> : <LanguagesIcon size={16} />}
      text={t(`endonym.${locale}`)}
      width={width}
    >
      {LOCALES.map((option) => (
        <Select.Item key={option} value={option}>
          {t(`endonym.${option}`)}
        </Select.Item>
      ))}
    </ToolbarSelect>
  );
}
