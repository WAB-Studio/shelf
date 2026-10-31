import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import styles from "./ui.module.css";

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function Page({ children }: { children: ReactNode }) {
  return <main className={styles.page}>{children}</main>;
}

export function Stack({ gap = 2, children }: { gap?: 1 | 2 | 3 | 4; children: ReactNode }) {
  return <div className={join(styles.stack, styles[`gap${gap}`])}>{children}</div>;
}

// Two ends of one line: a name and its figure, a title and its steps.
export function Between({ children }: { children: ReactNode }) {
  return <div className={styles.between}>{children}</div>;
}

type MeterSize = "large" | "default" | "compact";

// A name and its figure over the bar under them, 48 tall at least (DESIGN «Hoy»). A long name
// truncates; the figure never wraps.
export function Meter({ name, figure, share, label, size = "default" }: { name: ReactNode; figure: ReactNode; share: number; label: string; size?: MeterSize }) {
  return (
    <div className={join(styles.stack, styles.gap1, styles.meter, size === "large" && styles.meterLarge, size === "compact" && styles.meterCompact)}>
      <div className={styles.line}>
        <Text truncate>{name}</Text>
        <Text mono>{figure}</Text>
      </div>
      <Bar share={share} label={label} />
    </div>
  );
}

// The brand block: the one dark block on the main screen.
export function Hero({ children }: { children: ReactNode }) {
  return <section className={styles.hero}>{children}</section>;
}

export function Title({ small, children }: { small?: boolean; children: ReactNode }) {
  return <h1 className={join(styles.title, small && styles.titleSmall)}>{children}</h1>;
}

// A time set big: its figures large, its units small. `mark` puts the signal highlight behind it.
export function Figure({ parts, mark }: { parts: { value: string; unit: string }[]; mark?: boolean }) {
  return (
    <p className={join(styles.figure, mark && styles.mark)}>
      {parts.map((part) => (
        <span key={part.unit}>
          {part.value}
          <span className={styles.unit}> {part.unit}</span>
        </span>
      ))}
    </p>
  );
}

type TextVariant = "total" | "row" | "meta";

export function Text({ variant = "row", mono, mark, truncate, as = "span", children }: { variant?: TextVariant; mono?: boolean; mark?: boolean; truncate?: boolean; as?: "span" | "p"; children: ReactNode }) {
  const Tag = as;
  return <Tag className={join(styles[variant], mono && styles.mono, mark && styles.mark, !mono && styles.name, truncate && styles.truncate)}>{children}</Tag>;
}

// Inside the brand block: a small label over a value.
export function Cards({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}

export function Card({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.card}>
      <Text variant="meta">{label}</Text>
      {children}
    </div>
  );
}

export type DayColumn = { key: string; label: string; figure: string; share: number; future: boolean; description: string; href?: string };

// Seven vertical columns, one per day, for the brand block; a day not reached is dimmed and empty.
export function DayColumns({ days }: { days: DayColumn[] }) {
  return (
    <div className={styles.days}>
      {days.map((day) => {
        const column = (
          <>
            <div className={styles.dayTrack} role="img" aria-label={day.description}>
              <div className={styles.dayFill} style={{ height: `${Math.max(0, Math.min(1, day.share)) * 100}%` }} />
            </div>
            <span className={join(styles.dayFigure, styles.mono)}>{day.future ? "" : day.figure}</span>
            <span className={styles.dayLabel}>{day.label}</span>
          </>
        );
        // A day reached opens on its own screen; one not reached stays a plain column.
        return day.href === undefined || day.future ? (
          <div key={day.key} className={join(styles.day, day.future && styles.dayFuture)}>
            {column}
          </div>
        ) : (
          <Link key={day.key} href={day.href} className={join(styles.day, styles.dayLink)}>
            {column}
          </Link>
        );
      })}
    </div>
  );
}

// The shared header: the logo mark and name on the left, the sections on the right.
export function Header({ brand, href, children }: { brand: ReactNode; href: string; children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <Link href={href} className={styles.brand}>
        <span className={styles.logo} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {brand}
      </Link>
      {children}
    </header>
  );
}

// One bar, its length a share of the longest (DESIGN: the only graphic).
export function Bar({ share, label }: { share: number; label: string }) {
  const percent = Math.max(0, Math.min(1, share)) * 100;
  return (
    <div className={styles.track} role="img" aria-label={label}>
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function TextLink({ current, pill, button, ...props }: ComponentProps<typeof Link> & { current?: boolean; pill?: boolean; button?: boolean }) {
  return <Link {...props} aria-current={current ? "page" : undefined} className={join(styles.link, current && styles.current, pill && styles.pill, button && styles.pillPrimary)} />;
}

export function Nav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className={styles.nav}>
      {children}
    </nav>
  );
}

export function Button({ quiet, danger, ...props }: ComponentProps<"button"> & { quiet?: boolean; danger?: boolean }) {
  return <button {...props} className={join(styles.button, quiet && styles.quiet, danger && styles.danger)} />;
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={styles.input} />;
}

// An input with its label always visible above it.
export function Field({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className={styles.field}>
      <Text variant="meta">{label}</Text>
      <Input {...props} />
    </label>
  );
}

// Answers a press in place: «¿Revocar?» and its two ends.
export function Confirm({ children }: { children: ReactNode }) {
  return <div className={styles.confirm}>{children}</div>;
}

export function Form(props: ComponentProps<"form">) {
  return <form {...props} className={styles.form} />;
}

export function CodeBlock({ children }: { children: ReactNode }) {
  return <div className={styles.codeBlock}>{children}</div>;
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className={styles.code}>{children}</pre>;
}
