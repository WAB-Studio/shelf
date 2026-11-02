"use client";

import { useEffect, useRef } from "react";

import styles from "./ui.module.css";

export type TimelineSegment = { key: string; label: string; description: string; left: number; width: number; lane: number; hue: number; place: "inside" | "after" | "before" };
// How many project colours the stylesheet holds; a seventh project in one day starts the colours over.
const PROJECT_HUES = 6;

export type TimelineMark = { key: string; label: string; left: number };

// A day laid along a line: each stretch a labelled segment on its lane, an hour ruler under it. The line is wider than a
// phone, so it scrolls, and it opens with `focus` (a share of its length) in the middle of the screen. It opens there once
// per `openKey` (the day shown): a refresh of the same day never moves what the person scrolled to.
export function Timeline({ segments, lanes, marks, focus, openKey, label }: { segments: TimelineSegment[]; lanes: number; marks: TimelineMark[]; focus: number; openKey: string; label: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const focusNow = useRef(focus);
  useEffect(() => {
    focusNow.current = focus;
  });
  useEffect(() => {
    const box = scroller.current;
    if (box !== null) box.scrollLeft = focusNow.current * box.scrollWidth - box.clientWidth / 2;
  }, [openKey]);
  return (
    <div ref={scroller} className={`${styles.timeline} ${styles.tone_claude}`} role="group" aria-label={label} tabIndex={0}>
      <div className={styles.timelineLine}>
        <div className={styles.timelineLanes} style={{ height: `${lanes * 40 - 4}px` }}>
          {segments.map((one) => (
            <div key={one.key} className={`${styles.segment} ${styles[`project_${one.hue % PROJECT_HUES}`]}`} data-label={one.place === "inside" ? undefined : one.place} role="img" aria-label={one.description} title={one.description} style={{ left: `${one.left * 100}%`, width: `${one.width * 100}%`, top: `${one.lane * 40}px` }}>
              <span>{one.label}</span>
            </div>
          ))}
        </div>
        <div className={styles.ruler} aria-hidden="true">
          {marks.map((mark) => (
            <span key={mark.key} className={styles.hourMark} style={{ left: `${mark.left * 100}%` }} data-edge={mark.left <= 0 ? "start" : mark.left >= 1 ? "end" : undefined}>
              {mark.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
