import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";

// RL-68: a word's place in the review, as the device keeps it. Plain numbers, so a row reads back from
// IndexedDB exactly as it was written; `ts-fsrs` only ever sees a card rebuilt from it.
export type ReviewCard = {
  key: string; // the `StudyRow` key: the lemma reached, or the form as normalised
  due: number; // epoch ms
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: number | null;
  introducedOn: string; // the local day it was first rated, YYYY-MM-DD: the daily cap counts these
};

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export const GRADES: readonly ReviewGrade[] = ["again", "hard", "good", "easy"];

const RATING: Record<ReviewGrade, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

// No fuzz: the same answer on the same day always schedules the same way, which a test can hold.
const scheduler = fsrs({ enable_fuzz: false });

export function localDay(now: number): string {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toCard(card: ReviewCard | null, now: number): Card {
  if (!card) return createEmptyCard(new Date(now));
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.lastReview === null ? undefined : new Date(card.lastReview),
  };
}

function fromCard(key: string, card: Card, introducedOn: string): ReviewCard {
  return {
    key,
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ? card.last_review.getTime() : null,
    introducedOn,
  };
}

// The card after one answer; a word never rated before starts here, on the day it is first answered.
export function rate(key: string, card: ReviewCard | null, grade: ReviewGrade, now: number): ReviewCard {
  const next = scheduler.next(toCard(card, now), new Date(now), RATING[grade]).card;
  return fromCard(key, next, card?.introducedOn ?? localDay(now));
}

// How long each answer would put the word away, in ms: what the four buttons say before one is pressed.
export function intervals(card: ReviewCard | null, now: number): Record<ReviewGrade, number> {
  const preview = scheduler.repeat(toCard(card, now), new Date(now));
  return {
    again: preview[Rating.Again].card.due.getTime() - now,
    hard: preview[Rating.Hard].card.due.getTime() - now,
    good: preview[Rating.Good].card.due.getTime() - now,
    easy: preview[Rating.Easy].card.due.getTime() - now,
  };
}

// An interval as the button reads it: whole minutes under an hour, hours under a day, then days.
export function intervalUnit(ms: number): { unit: "minutes" | "hours" | "days"; count: number } {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return { unit: "minutes", count: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { unit: "hours", count: hours };
  return { unit: "days", count: Math.round(hours / 24) };
}

// RL-78: an answer that puts the entry away for less than this brings it back in the same session.
const SESSION_REQUEUE_MS = 5 * 60_000;

export function staysInSession(card: ReviewCard, now: number): boolean {
  return card.due - now <= SESSION_REQUEUE_MS;
}
