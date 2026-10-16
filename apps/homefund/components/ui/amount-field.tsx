import type { ComponentProps } from "react";
import { TextField } from "@radix-ui/themes";

type AmountFieldProps = Omit<ComponentProps<typeof TextField.Root>, "style" | "className"> & {
  // The field's width in px, for one that sits beside others in a row.
  width?: number;
};

// A text field for a figure: tabular numerals, so digits line up row over row,
// and optionally a fixed width.
export function AmountField({ width, ...props }: AmountFieldProps) {
  return <TextField.Root {...props} style={{ width, fontVariantNumeric: "tabular-nums" }} />;
}
