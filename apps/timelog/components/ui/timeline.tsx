"use client";

import { useEffect, useRef } from "react";

import styles from "./ui.module.css";

export type TimelineSegment = { key: string; label: string; description: string; left: number; width: number; lane: number };
export type TimelineMark = { key: string; label: string; left: number };

// A day laid along a line: each stretch a labelled segment on its lane, an hour ruler under it. The line is wider than a
// phone, so it scrolls, and it opens with `focus` (a share of its length) in the middle of the screen.
export function Timeline({ segments, lanes, marks, focus, label }: { segments: TimelineSegment[]; lanes: number; marks: TimelineMark[]; focus: number; label: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scroller.current;
    if (box !== null) box.scrollLeft = focus * box.scrollWidth - box.clientWidth / 2;
  }, [focus]);
  return (
    <div ref={scroller} className={`${styles.timeline} ${styles.tone_claude}`} role="group" aria-label={label} tabIndex={0}>
      <div className={styles.timelineLine}>
        <div className={styles.timelineLanes} style={{ height: `${lanes * 40 - 4}px` }}>
          {segments.map((one) => (
            <div key={one.key} className={styles.segment} role="img" aria-label={one.description} title={one.description} style={{ left: `${one.left * 100}%`, width: `${one.width * 100}%`, top: `${one.lane * 40}px` }}>
              <span>{one.label}</span>
            </div>
          ))}
        </div>
        <div className={styles.ruler} aria-hidden="true">
          {marks.map((mark, index) => (
            <span key={mark.key} className={styles.hourMark} style={{ left: `${mark.left * 100}%` }} data-edge={index === 0 ? "start" : index === marks.length - 1 ? "end" : undefined}>
              {mark.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
