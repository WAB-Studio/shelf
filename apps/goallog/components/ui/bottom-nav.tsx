"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type FocusEvent, type MouseEvent } from "react";
import { usePathname } from "next/navigation";

import { ThemeToggle } from "./theme-toggle";
import styles from "./bottom-nav.module.css";

// How many `NoTabMarked` are mounted. A store, not context: the marker is
// rendered by a not-found page beside the nav, not inside it.
let unmarkers = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const readUnmarked = () => unmarkers > 0;
const serverUnmarked = () => false;
const setUnmarkers = (change: number) => {
  unmarkers += change;
  listeners.forEach((listener) => listener());
};

// Rendered by a not-found: no tab reads as current. The `data` attribute is
// what `bottom-nav.module.css` reads from the first paint; the store is what
// drops `aria-current` once the page hydrates.
export function NoTabMarked() {
  useEffect(() => {
    setUnmarkers(1);
    return () => setUnmarkers(-1);
  }, []);

  return <span hidden data-no-tab-marked />;
}

// How wide the screen is, as the CSS reads it: from 768px the nav is the
// rail and a goal's own pages mark that goal's item, below it they mark `Metas`.
const WIDE = "(min-width: 768px)";
const subscribeWide = (listener: () => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const readWide = () => window.matchMedia(WIDE).matches;
const serverWide = () => false;

// The four routes every screen stands over — `Hoy`, `Semana`, `Mes`, `Metas` —
// fixed here rather than configured by a screen: `app/(app)/layout.tsx` is the
// one place that mounts this, so there is only ever one nav in the tree
// (RNP-07's own floor: four equal links, each at least 48px). Labels arrive as
// already-translated strings, never a function, since a Server Component cannot
// hand this Client one anything but a serializable prop.
//
// From 768px the same links are the desktop rail (RNP-17): the props below
// `labels` fill the parts only the rail draws, and none of them renders below
// that width. The visual mark of a goal's page is CSS from the first paint;
// `aria-current` follows the width once the page hydrates.
type Balloon = { name: string; top: number; left: number };

// A goal of the rail's tree. `depth` is its level (0 root, 1 large, 2 small), `holds` says it has
// goals inside and so a fold control; the two labels carry its own name. Folding is this nav's
// alone: nothing is stored and a reload draws every branch open.
export type RailGoal = {
  id: string;
  name: string;
  parentId?: string | null;
  depth?: 0 | 1 | 2;
  holds?: boolean;
  foldLabel?: string;
  unfoldLabel?: string;
};

const LEVELS = ["levelRoot", "levelLarge", "levelSmall"] as const;

export function BottomNav({
  labels,
  appName,
  date,
  theme,
  goals = [],
  goalsSectionLabel,
}: {
  labels: { today: string; week: string; month: string; goals: string };
  appName?: string;
  date?: string;
  theme?: { toLightLabel: string; toDarkLabel: string };
  goals?: RailGoal[];
  goalsSectionLabel?: string;
}) {
  const pathname = usePathname();
  const [balloon, setBalloon] = useState<Balloon | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const unmarked = useSyncExternalStore(subscribe, readUnmarked, serverUnmarked);
  const wide = useSyncExternalStore(subscribeWide, readWide, serverWide);
  // The name's first word is the mark, the rest its mono line under it.
  const [firstWord, ...rest] = (appName ?? "").split(" ");
  const restWords = rest.join(" ");

  const openGoal = goals.find(
    (goal) => pathname === `/metas/${goal.id}` || pathname.startsWith(`/metas/${goal.id}/`),
  );
  // `/conexiones` and `/exportar` hang from Metas: no tab of their own, so they mark that one.
  const onGoals =
    pathname.startsWith("/metas") || pathname.startsWith("/conexiones") || pathname.startsWith("/exportar");

  // The rail cuts a long name; hover and keyboard focus show it whole, beside
  // the link. Fixed, since the scrolling goal list would clip anything outside it.
  const showBalloon = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>, name: string) => {
    const link = event.currentTarget;
    const label = link.firstElementChild;
    if (!label || label.scrollWidth <= label.clientWidth) return setBalloon(null);
    if (event.type === "focus" && !link.matches(":focus-visible")) return;
    const { top, bottom, right } = link.getBoundingClientRect();
    setBalloon({ name, top: (top + bottom) / 2, left: right + 8 });
  };
  const hideBalloon = () => setBalloon(null);

  const parentOf = new Map(goals.map((goal) => [goal.id, goal.parentId ?? null]));
  const hidden = (goal: RailGoal) => {
    for (let up = goal.parentId ?? null; up; up = parentOf.get(up) ?? null) {
      if (folded.has(up)) return true;
    }
    return false;
  };
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Every row keeps the arrow's slot once any goal holds others, so names align by level.
  const slotted = goals.some((goal) => goal.holds);

  const items = [
    { href: "/", label: labels.today, active: pathname === "/" || pathname.startsWith("/sueltas") },
    { href: "/semana", label: labels.week, active: pathname.startsWith("/semana") },
    { href: "/mes", label: labels.month, active: pathname === "/mes" },
    { href: "/metas", label: labels.goals, active: onGoals },
  ];

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        {appName ? (
          <div className={styles.brand}>
            <span className={styles.appName}>{firstWord}</span>
            {restWords ? <span className={styles.appSub}>{restWords}</span> : null}
          </div>
        ) : null}
        {items.map((item) => {
          // From 768 a goal of the list owns its pages' mark; `Metas` keeps
          // the visual mark below that width only.
          const owned = item.href === "/metas" && openGoal !== undefined;
          const marked = item.active && !unmarked;
          const current = marked && !(owned && wide);
          const className = !marked
            ? styles.link
            : owned
              ? `${styles.link} ${styles.activeNarrow}`
              : `${styles.link} ${styles.active}`;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={className}
            >
              {item.label}
            </Link>
          );
        })}
        {goals.length > 0 && goalsSectionLabel ? (
          <>
            <div className={styles.sectionLabel}>{goalsSectionLabel}</div>
            <div
              role="region"
              aria-label={goalsSectionLabel}
              tabIndex={0}
              className={styles.goals}
            >
              {goals
                .filter((goal) => !hidden(goal))
                .map((goal) => {
                  const current = openGoal?.id === goal.id && !unmarked;
                  const expanded = !folded.has(goal.id);
                  const link = current ? `${styles.goal} ${styles.goalActive}` : styles.goal;
                  return (
                    <div key={goal.id} className={`${styles.goalRow} ${styles[LEVELS[goal.depth ?? 0]]}`}>
                      {slotted ? (
                        goal.holds ? (
                          <button
                            type="button"
                            className={styles.foldButton}
                            aria-expanded={expanded}
                            aria-label={expanded ? goal.foldLabel : goal.unfoldLabel}
                            onClick={() => toggle(goal.id)}
                          >
                            {expanded ? (
                              <ChevronDown size={16} strokeWidth={1.5} aria-hidden />
                            ) : (
                              <ChevronRight size={16} strokeWidth={1.5} aria-hidden />
                            )}
                          </button>
                        ) : (
                          <span className={styles.foldSlot} aria-hidden />
                        )
                      ) : null}
                      <Link
                        href={`/metas/${goal.id}`}
                        onMouseEnter={(event) => showBalloon(event, goal.name)}
                        onMouseLeave={hideBalloon}
                        onFocus={(event) => showBalloon(event, goal.name)}
                        onBlur={hideBalloon}
                        aria-current={current && wide ? "page" : undefined}
                        className={slotted ? `${link} ${styles.goalSlotted}` : link}
                      >
                        <span className={styles.goalName}>{goal.name}</span>
                      </Link>
                    </div>
                  );
                })}
            </div>
          </>
        ) : null}
        {balloon ? (
          <div
            aria-hidden="true"
            data-goal-balloon
            className={styles.balloon}
            style={{ top: balloon.top, left: balloon.left }}
          >
            {balloon.name}
          </div>
        ) : null}
        {date || theme ? (
          <div className={styles.foot}>
            {date ? <span className={styles.date}>{date}</span> : null}
            {theme ? <ThemeToggle {...theme} /> : null}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
