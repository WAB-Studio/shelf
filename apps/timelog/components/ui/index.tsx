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

// A name and its figure over the bar under them, 48 tall at least (DESIGN «Hoy»).
export function Meter({ name, figure, share, label }: { name: ReactNode; figure: ReactNode; share: number; label: string }) {
  return (
    <div className={join(styles.stack, styles.gap1, styles.meter)}>
      <div className={styles.line}>
        <Text>{name}</Text>
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

export function Title({ children }: { children: ReactNode }) {
  return <h1 className={styles.title}>{children}</h1>;
}

type TextVariant = "total" | "row" | "meta";

export function Text({ variant = "row", mono, mark, as = "span", children }: { variant?: TextVariant; mono?: boolean; mark?: boolean; as?: "span" | "p"; children: ReactNode }) {
  const Tag = as;
  return <Tag className={join(styles[variant], mono && styles.mono, mark && styles.mark, !mono && styles.name)}>{children}</Tag>;
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

export function TextLink({ current, ...props }: ComponentProps<typeof Link> & { current?: boolean }) {
  return <Link {...props} aria-current={current ? "page" : undefined} className={join(styles.link, current && styles.current)} />;
}

export function Nav({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className={styles.nav}>
      {children}
    </nav>
  );
}

export function Button({ quiet, ...props }: ComponentProps<"button"> & { quiet?: boolean }) {
  return <button {...props} className={join(styles.button, quiet && styles.quiet)} />;
}

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={styles.input} />;
}

export function Form(props: ComponentProps<"form">) {
  return <form {...props} className={styles.form} />;
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className={styles.code}>{children}</pre>;
}
