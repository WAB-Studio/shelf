"use client";

import type { ComponentProps } from "react";
import { useLocale } from "next-intl";
import { TextField } from "@radix-ui/themes";

// A native date field that reads in the app's language: the browser lays the
// day, month and year out by the field's own `lang`, not by the page's menu.
export function DateInput(props: Omit<ComponentProps<typeof TextField.Root>, "type">) {
  const locale = useLocale();
  return <TextField.Root {...props} type="date" lang={locale} />;
}
