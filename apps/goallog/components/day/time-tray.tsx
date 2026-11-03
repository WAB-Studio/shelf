"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { confirmTimeEntry, dismissTimeEntry } from "@/app/actions/time-entries";
import { Button, Field, Flex, Row, Sheet, Text } from "@/components/ui";
import { useTimeWords } from "@/components/ui/figure";
import type { MessageKey } from "@/i18n/translator";
import type { TimeGoal, WaitingEntry } from "@/lib/queries/time-entries";
import { formatTime } from "@/lib/units/time";
import { quantitySchema } from "@/lib/validation/fact";
import { settlement } from "@/lib/validation/time-entry";

type Run = (act: () => Promise<{ ok: true } | { ok: false; error: MessageKey }>) => void;

function EntryCard({
  entry,
  goals,
  today,
  pending,
  run,
}: {
  entry: WaitingEntry;
  goals: TimeGoal[];
  today: string;
  pending: boolean;
  run: Run;
}) {
  const t = useTranslations();
  const words = useTimeWords();
  const [splitting, setSplitting] = useState(false);
  const [parts, setParts] = useState<Record<string, string>>({});

  const suggested = goals.find((goal) => goal.id === entry.suggestedGoalId) ?? null;
  const others = goals.filter((goal) => goal.id !== suggested?.id);
  const months = t.raw("day.monthLong") as string[];

  const name =
    entry.source === "task" && entry.taskName
      ? t("day.timeTray.fromTask", { name: entry.taskName })
      : t(entry.source === "timelog" ? "day.timeTray.fromTimelog" : "day.timeTray.fromChat");
  const when = entry.day === today ? null : t("day.timeTray.dayLabel", { day: Number(entry.day.slice(8, 10)), month: months[Number(entry.day.slice(5, 7)) - 1] });
  const meta = [formatTime(entry.minutes, words), when].filter(Boolean).join(" · ");

  const lines = goals.flatMap((goal) => {
    const parsed = quantitySchema.safeParse(Number(parts[goal.id]));
    return parsed.success ? [{ goalId: goal.id, minutes: parsed.data }] : [];
  });
  const placed = lines.reduce((total, line) => total + line.minutes, 0);
  const exact = settlement(entry.minutes, lines) === "exact";

  const give = (goalId: string) => run(() => confirmTimeEntry({ entryId: entry.id, allocations: [{ goalId, minutes: entry.minutes }] }));

  return (
    <Flex direction="column" gap="2" py="3">
      <Text as="p" strong>
        {name}
      </Text>
      <Text as="p" variant="meta">
        {meta}
      </Text>
      {entry.note ? (
        <Text as="p" variant="sentence">
          {entry.note}
        </Text>
      ) : null}

      {splitting ? (
        <>
          {goals.map((goal) => (
            <Field
              key={goal.id}
              label={t("day.timeTray.splitGoalLabel", { goal: goal.name })}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={parts[goal.id] ?? ""}
              onChange={(event) => setParts({ ...parts, [goal.id]: event.target.value })}
            />
          ))}
          <Text as="p" variant="meta">
            {exact ? t("day.timeTray.splitDone") : t("day.timeTray.splitLeft", { time: formatTime(Math.max(entry.minutes - placed, 0), words) })}
          </Text>
          <Button block disabled={pending || !exact} onClick={() => run(() => confirmTimeEntry({ entryId: entry.id, allocations: lines }))}>
            {t("day.timeTray.splitConfirm")}
          </Button>
          <Button variant="ghost" onClick={() => setSplitting(false)}>
            {t("day.timeTray.back")}
          </Button>
        </>
      ) : (
        <>
          {suggested ? (
            <Button block disabled={pending} onClick={() => give(suggested.id)}>
              {t("day.timeTray.confirmTo", { goal: suggested.name })}
            </Button>
          ) : null}
          {others.map((goal) => (
            <Button key={goal.id} block variant="outline" disabled={pending} onClick={() => give(goal.id)}>
              {t("day.timeTray.give", { goal: goal.name })}
            </Button>
          ))}
          {goals.length > 1 ? (
            <Button variant="ghost" disabled={pending} onClick={() => setSplitting(true)}>
              {t("day.timeTray.split")}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={pending} onClick={() => run(() => dismissTimeEntry({ entryId: entry.id }))}>
            {t("day.timeTray.dismiss")}
          </Button>
        </>
      )}
    </Flex>
  );
}

/**
 * The line at the top of Hoy that says how much time waits «por confirmar» (RP-151) and the tray it opens: each
 * entry is confirmed for the goal it suggests, given to another, split across several, or marked «no cuenta».
 */
export function TimeTray({
  entries,
  goals,
  today,
}: {
  entries: WaitingEntry[];
  goals: TimeGoal[];
  today: string;
}) {
  const t = useTranslations();
  const words = useTimeWords();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<MessageKey | null>(null);

  if (entries.length === 0) return null;

  const run: Run = (act) => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await act().catch(() => null);
      if (result && !result.ok) setError(result.error);
      // The last entry settled leaves nothing to show: the tray closes with it, and opens closed next time.
      else if (result && entries.length <= 1) setOpen(false);
    });
  };

  const total = entries.reduce((sum, entry) => sum + entry.minutes, 0);

  return (
    <>
      <Row
        name={t("day.timeTray.line", { count: entries.length, time: formatTime(total, words) })}
        aria-label={t("day.timeTray.open")}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      />
      <Sheet open={open} onOpenChange={setOpen} title={t("day.timeTray.title")} description={t("day.timeTray.description")}>
        {goals.length === 0 ? (
          <Text as="p" variant="sentence">
            {t("day.timeTray.noGoals")}
          </Text>
        ) : null}
        {entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} goals={goals} today={today} pending={pending} run={run} />
        ))}
        {error ? (
          <Text as="p" variant="sentence">
            {t(error)}
          </Text>
        ) : null}
      </Sheet>
    </>
  );
}
