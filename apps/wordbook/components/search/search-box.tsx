"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { IconButton, TextField } from "@/components/ui";

// The one input the whole app answers from: no submit, no mode, never
// disabled — a status the box cannot read must never take its focus (RL-77).
export function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  const t = useTranslations("search");
  const inputRef = useRef<HTMLInputElement>(null);

  // Grabbed once, on mount, and never again: nothing later in the install
  // is allowed to steal it back.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <TextField.Root
      ref={inputRef}
      size="3"
      edge
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={t("placeholder")}
      label={t("label")}
      lang="en"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="search"
    >
      {value.length > 0 && (
        <TextField.Slot side="right">
          <IconButton
            type="button"
            size="2"
            variant="ghost"
            color="gray"
            aria-label={t("clear")}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
          >
            <X size={16} />
          </IconButton>
        </TextField.Slot>
      )}
    </TextField.Root>
  );
}
