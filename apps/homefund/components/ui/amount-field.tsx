"use client";

import type { ChangeEvent, ComponentProps } from "react";
import { useLocale } from "next-intl";
import { TextField } from "@radix-ui/themes";

import { formatAmountTyping } from "@/lib/money";

type AmountFieldProps = Omit<ComponentProps<typeof TextField.Root>, "style" | "className"> & {
  // The field's width in px, for one that sits beside others in a row.
  width?: number;
};

// A text field for a figure: tabular numerals, so digits line up row over row,
// optionally a fixed width, and thousands grouped as the person types. The text
// it hands to `onChange` is the grouped one, which `parseAmount` reads back as
// the same integer.
export function AmountField({ width, onChange, value, ...props }: AmountFieldProps) {
  // A figure written into the form from outside (the interpreter's «45 mil», a
  // suggestion tapped) arrives as bare digits; the field shows it grouped the
  // way typing would. Anything with a decimal mark is shown as it is.
  const locale = useLocale();
  const shown =
    typeof value === "string" && /^\d{4,}$/.test(value)
      ? formatAmountTyping(value, value.length, locale).text
      : value;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const { text, caret } = formatAmountTyping(
      input.value,
      input.selectionStart ?? input.value.length,
      locale,
    );
    if (text !== input.value) {
      input.value = text;
      input.setSelectionRange(caret, caret);
    }
    onChange?.(event);
  }

  return (
    <TextField.Root
      {...props}
      value={shown}
      onChange={handleChange}
      style={{ width, fontVariantNumeric: "tabular-nums" }}
    />
  );
}
