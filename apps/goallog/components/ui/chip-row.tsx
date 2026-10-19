"use client";

import { Children, cloneElement, isValidElement, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import styles from "./chip-row.module.css";

// A row of chips that wraps by chip. `tight` is the seven weekday chips, which
// sit 4px apart; every other row keeps 8. With `radio` and a `label` the row is
// a radio group: one chip is in the tab order and the arrows move the check.
export function ChipRow({
  tight,
  radio,
  label,
  children,
}: {
  tight?: boolean;
  radio?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const className = [styles.row, tight ? styles.tight : undefined].filter(Boolean).join(" ");
  if (!radio) return <div className={className}>{children}</div>;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const at = radios.findIndex((chip) => chip === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    next.focus();
    next.click();
  };

  const chips = Children.toArray(children).filter(isValidElement) as ReactElement<{ selected?: boolean }>[];
  const anyChecked = chips.some((chip) => chip.props.selected);
  return (
    <div role="radiogroup" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {chips.map((chip, index) =>
        cloneElement(chip as ReactElement<{ tabIndex?: number }>, {
          tabIndex: chip.props.selected || (!anyChecked && index === 0) ? 0 : -1,
        }),
      )}
    </div>
  );
}
