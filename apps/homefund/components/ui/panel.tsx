import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { forwardRef } from "react";
import { Flex, Heading } from "@radix-ui/themes";

import { Link as LocaleLink } from "@/i18n/navigation";
import styles from "./panel.module.css";

// One cell of a row, on the track at its index.
export type PanelCell = {
  key: string;
  content: ReactNode;
  align?: "start" | "end";
  // Figures line up row over row: the cell reads in tabular numerals (SPEC-A3).
  numeric?: boolean;
};

/**
 * The card SPEC-A3 draws where the dense table does not fit. `stack` carries an
 * optional heading over `PanelRow`s; `inline` is one padded row of controls,
 * which is what the wide quick entry is.
 *
 * State never lives here: what a row leads to and what a control does are the
 * caller's.
 */
export function Panel({
  title,
  action,
  variant = "stack",
  children,
}: {
  title?: string;
  // Rides at the head's end, opposite the title: the block's one way out.
  action?: ReactNode;
  variant?: "stack" | "inline";
  children?: ReactNode;
}) {
  return (
    <div className={styles.panel} data-variant={variant}>
      {(title || action) && (
        <Flex align="center" justify="between" gap="3" className={styles.head}>
          {title && (
            <Heading as="h2" size="3">
              {title}
            </Heading>
          )}
          {action}
        </Flex>
      )}
      {children}
    </div>
  );
}

/**
 * One row of a stacked panel: a link the full width of the card, laid on the
 * grid tracks the caller names. `columns` is a grid template — "36px 1fr" — and
 * every row of a panel takes the same one, so the cells line up column-wise.
 */
export function PanelRow({
  href,
  columns,
  cells,
}: {
  href: string;
  columns: string;
  cells: PanelCell[];
}) {
  return (
    <LocaleLink
      href={href}
      className={styles.row}
      style={{ "--panel-row-columns": columns } as CSSProperties}
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          className={styles.cell}
          data-align={cell.align}
          data-numeric={cell.numeric || undefined}
        >
          {cell.content}
        </div>
      ))}
    </LocaleLink>
  );
}

/**
 * A control that carries no chrome of its own: the surface around it is what the
 * person sees. `inset` sits on a panel and sheds what the browser draws;
 * `surface` is the whole card, whose own reset already did that.
 *
 * It forwards the ref and the props a layout or a trigger clones onto it
 * (asChild), so `Flex` can grow it and `Card` can become it.
 */
export const PanelButton = forwardRef<
  HTMLButtonElement,
  { variant?: "inset" | "surface" } & ComponentPropsWithoutRef<"button">
>(function PanelButton({ variant = "inset", className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-variant={variant}
      {...props}
      className={className ? `${styles.button} ${className}` : styles.button}
    />
  );
});
