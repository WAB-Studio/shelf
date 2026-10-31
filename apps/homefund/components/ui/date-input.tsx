"use client";

import { useRef, useState, type ChangeEvent, type ComponentProps } from "react";
import { CalendarDays } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { TextField } from "@radix-ui/themes";

import { IconButton } from "./button";

import { dateOrderOf, datePlaceholder, isoToText, textToIso } from "@/lib/date-text";
import styles from "./date-input.module.css";

type DateInputProps = Omit<
  ComponentProps<typeof TextField.Root>,
  "type" | "value" | "onChange" | "defaultValue"
> & {
  // The civil date, «YYYY-MM-DD», or empty: the same value a native date field holds.
  value?: string;
  // Called with an event whose `target.value` is the civil date or empty, so a form
  // controller and a plain handler read it as they read a native field.
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  calendarLabel?: string;
};

// A date field that reads «dd/mm/aaaa» in Spanish and «mm/dd/yyyy» in English whatever
// the browser or the OS prefers, with a calendar button for the picker. Underneath it
// holds and emits the civil date, so no form or schema changes.
export function DateInput({ value = "", onChange, onBlur, calendarLabel, name, ...rest }: DateInputProps) {
  const locale = useLocale();
  const t = useTranslations("common");
  const order = dateOrderOf(locale);
  const picker = useRef<HTMLInputElement>(null);
  // The text being typed; null while the field simply mirrors its value.
  const [draft, setDraft] = useState<string | null>(null);

  function emit(next: string) {
    onChange?.({ target: { value: next, name } } as ChangeEvent<HTMLInputElement>);
  }

  return (
    <TextField.Root
      {...rest}
      name={name}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={datePlaceholder(locale)}
      value={draft ?? isoToText(value, order)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const iso = textToIso(text, order);
        if (iso !== null) emit(iso);
        else if (text.trim() === "") emit("");
      }}
      onBlur={(event) => {
        // A half-typed date leaves the field as the value it still holds.
        setDraft(null);
        onBlur?.(event);
      }}
    >
      <TextField.Slot side="right">
        <span className={styles.wrap}>
        <IconButton
          type="button"
          tap
          variant="ghost"
          color="gray"
          disabled={rest.disabled}
          aria-label={calendarLabel ?? t("openCalendar")}
          onClick={() => picker.current?.showPicker?.()}
        >
          <CalendarDays size={16} />
        </IconButton>
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden
          className={styles.native}
          value={value}
          onChange={(event) => {
            setDraft(null);
            emit(event.target.value);
          }}
        />
        </span>
      </TextField.Slot>
    </TextField.Root>
  );
}
