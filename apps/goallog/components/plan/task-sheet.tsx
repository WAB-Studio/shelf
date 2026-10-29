"use client";

import { useState, useTransition } from "react";
import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { createOneOff, editTask } from "@/app/actions/one-offs";
import { OneOffDeleteSheet } from "@/components/day/one-off-delete-sheet";
import {
  Button,
  Chip,
  ChipRow,
  Field,
  FieldPair,
  Flex,
  Mark,
  Row,
  Separator,
  Sheet,
  SheetActions,
  Text,
} from "@/components/ui";
import { messageKey, type MessageKey } from "@/i18n/translator";
import { monthName } from "@/lib/plan/month-name";
import { isTimeUnit, minutesFromFields, splitMinutes } from "@/lib/units/time";
import { createOneOffSchema, editTaskSchema } from "@/lib/validation/one-off";
import { todayInZone } from "@/lib/zone";

// A loose task's name refusals speak of «lo suelto»; a goal's task has its own.
function own(key: MessageKey): MessageKey {
  if (key === "day.errors.oneOffNameEmpty") return "roadmap.errors.nameEmpty";
  if (key === "day.errors.oneOffNameTooLong") return "roadmap.errors.nameTooLong";
  return key;
}

export type TaskSheetProps = {
  mode: "create" | "edit";
  // Absent on a suelta (RP-57), which belongs to no goal.
  goalId?: string;
  goalName?: string;
  oneOffId?: string;
  name?: string;
  // In the goal's unit; null while the task has none.
  estimate?: number | null;
  // Null for a goal that measures nothing: the sheet then asks no estimate.
  unit: string | null;
  // "YYYY-MM" the task is fixed to; null when the plan places it.
  fixedMonth: string | null;
  // "YYYY-MM" the plan gives it, or would give it unfixed; null when it gives none.
  planMonth: string | null;
  // "YYYY-MM" of every open month of the goal's span.
  months: string[];
  done: boolean;
  // "loose" takes its name alone: a suelta, or a goal's one-off outside the plan (`SueltaHoja`).
  kind: "task" | "parent" | "child" | "loose";
  // RP-22: nothing done under it.
  canDelete: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // `/sueltas`: the way to the one-off's day, a row inside the sheet.
  onGiveDay?: () => void;
  // Names that row; «Darle un día» when absent (`/sueltas`).
  giveDayLabel?: MessageKey;
};

/**
 * `RoadmapFijar` and `RoadmapTareaNueva` (RP-51, RP-55): a task's name, its
 * estimate and its month, saved through `editTask`, or a new task of the plan
 * through `createOneOff`. A done task takes its name alone, a sub-task and a
 * parent never take the field the plan reads off their parts. Runs the
 * actions' own schema before them.
 */
export function TaskSheet({
  mode,
  goalId,
  goalName,
  oneOffId,
  name: current = "",
  estimate = null,
  unit,
  fixedMonth,
  planMonth,
  months,
  done,
  kind,
  canDelete,
  open,
  onOpenChange,
  onGiveDay,
  giveDayLabel = "oneOffs.sheet.giveDay",
}: TaskSheetProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const timed = isTimeUnit(unit);
  const thisYear = todayInZone().slice(0, 4);

  const initial = estimate !== null && timed
    ? { hours: String(splitMinutes(estimate).h), minutes: String(splitMinutes(estimate).min) }
    : { hours: "", minutes: "" };
  const start = fixedMonth ?? months.find((month) => planMonth === null || month >= planMonth) ?? months[0] ?? "";

  const [name, setName] = useState(current);
  const [hours, setHours] = useState(initial.hours);
  const [minutes, setMinutes] = useState(initial.minutes);
  const [pin, setPin] = useState(fixedMonth !== null);
  const [month, setMonth] = useState(start);
  const [error, setError] = useState<{ key: MessageKey; field: "name" | "estimate" | "month" } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Every open starts from what the task holds, never a leftover.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(current);
      setHours(initial.hours);
      setMinutes(initial.minutes);
      setPin(fixedMonth !== null);
      setMonth(start);
      setError(null);
    }
  }

  const loose = kind === "loose";
  const asksEstimate = timed && kind !== "parent" && !loose && !done;
  const asksMonth = kind !== "child" && !loose && !done;

  // Minutes (or the unit's count) typed; null while blank; a key for a figure the sheet refuses.
  function typed(): number | null | MessageKey {
    const read = minutesFromFields(hours, minutes);
    if (read.kind === "blank") return null;
    if (read.kind === "hoursInvalid") return "month.errors.estimateInvalid";
    if (read.kind === "minutesInvalid") return "month.errors.minutesInvalid";
    return read.minutes;
  }

  function refuse(raw: MessageKey) {
    const key = own(raw);
    const field = key === "roadmap.errors.nameEmpty" || key === "roadmap.errors.nameTooLong" ? "name" : key.startsWith("roadmap.errors.month") || key === "roadmap.errors.dayInMonth" || key === "roadmap.errors.subTaskMonth" ? "month" : "estimate";
    setError({ key, field });
  }

  function finish(result: { ok: boolean; error?: MessageKey }) {
    if (result.ok) {
      onOpenChange(false);
      router.refresh();
    } else refuse(result.error ?? "month.errors.invalid");
  }

  function save() {
    if (pending) return;
    setError(null);

    let amount: number | null = null;
    if (asksEstimate) {
      const value = typed();
      if (typeof value === "string") return refuse(value);
      amount = value;
    }
    const fixes = asksMonth && (pin || !timed) && month !== "" ? month : null;

    if (mode === "create") {
      const parsed = createOneOffSchema.safeParse({
        name,
        day: null,
        goalId: goalId ?? null,
        estimate: amount,
        // No plan places a task of a goal that does not measure time; the server fixes its month.
        ...(fixes ? { plannedMonth: fixes } : timed ? { inPlan: true } : {}),
      });
      if (!parsed.success) return refuse(messageKey(parsed.error.issues[0].message));
      startTransition(() => void createOneOff(parsed.data).then(finish));
      return;
    }

    const parsed = editTaskSchema.safeParse({
      oneOffId,
      name,
      ...(asksEstimate && amount !== (estimate ?? null) ? { estimate: amount } : {}),
      ...(asksMonth && (fixes ?? null) !== fixedMonth ? { month: fixes } : {}),
    });
    if (!parsed.success) return refuse(messageKey(parsed.error.issues[0].message));
    startTransition(() => void editTask(parsed.data).then(finish));
  }

  // The month a task is held in stays a chip once it closes, offered to no one else.
  const offered = fixedMonth !== null && !months.includes(fixedMonth) ? [...months, fixedMonth].sort() : months;
  const plans = planMonth !== null ? monthName(planMonth, thisYear) : null;
  const refused = (field: "name" | "estimate" | "month") => (error?.field === field ? error : null);

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        label={
          goalName !== undefined
            ? t("roadmap.fijar.eyebrow", { goal: goalName })
            : t(done ? "oneOffs.sheet.eyebrowDone" : "oneOffs.sheet.eyebrow")
        }
        title={mode === "create" ? t("roadmap.fijar.newTitle") : current}
      >
        <Flex direction="column" gap="5">
          <Field
            label={t("roadmap.fijar.name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            invalid={refused("name") !== null}
            hint={
              refused("name")
                ? t(refused("name")!.key)
                : kind === "parent"
                  ? t("roadmap.fijar.parentSum")
                  : loose && done
                    ? t("oneOffs.sheet.doneHint")
                    : undefined
            }
            autoFocus={mode === "create"}
          />

          {asksEstimate ? (
            <FieldPair baseline>
              <Field
                label={t("roadmap.fijar.estimate")}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                suffix={t("roadmap.fijar.hours")}
              />
              <Field
                label={t("roadmap.fijar.minutes")}
                hideLabel
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                step={1}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                suffix={t("roadmap.fijar.minutes")}
                invalid={refused("estimate") !== null}
              />
            </FieldPair>
          ) : null}
          {asksEstimate && refused("estimate") ? (
            <Text as="p" variant="sentence" role="alert">
              {t(refused("estimate")!.key)}
            </Text>
          ) : null}

          {asksMonth ? (
            <Flex direction="column" gap="2" role="radiogroup" aria-label={t("roadmap.fijar.month")}>
              <Text variant="name">{t("roadmap.fijar.month")}</Text>
              {timed ? (
                <>
                  <Row
                    role="radio"
                    aria-checked={!pin}
                    leading={<Mark state={pin ? "empty" : "declared"} />}
                    name={t("roadmap.fijar.planPicks")}
                    trailing={
                      plans !== null ? (
                        <Text variant="meta" tone="muted">
                          {t(mode === "create" ? "roadmap.fijar.goesTo" : "roadmap.fijar.today", { month: plans })}
                        </Text>
                      ) : undefined
                    }
                    onClick={() => setPin(false)}
                  />
                  <Row
                    role="radio"
                    aria-checked={pin}
                    leading={<Mark state={pin ? "declared" : "empty"} />}
                    name={t("roadmap.fijar.pinIn")}
                    rule={false}
                    onClick={() => setPin(true)}
                  />
                </>
              ) : null}
              {pin || !timed ? (
                <ChipRow radio label={t("roadmap.fijar.month")}>
                  {offered.map((value) => (
                    <Chip key={value} radio selected={month === value} onClick={() => setMonth(value)}>
                      {monthName(value, thisYear)}
                    </Chip>
                  ))}
                </ChipRow>
              ) : null}
              {refused("month") ? (
                <Text as="p" variant="sentence" role="alert">
                  {t(refused("month")!.key)}
                </Text>
              ) : null}
              <Text as="p" variant="sentence">
                {t(timed ? "roadmap.fijar.pinHint" : "roadmap.fijar.pinHintUntimed")}
              </Text>
            </Flex>
          ) : null}

          {error && ((error.field === "estimate" && !asksEstimate) || (error.field === "month" && !asksMonth)) ? (
            <Text as="p" variant="sentence" role="alert">
              {t(error.key)}
            </Text>
          ) : null}
        </Flex>

        <SheetActions>
          <Button block onClick={save} disabled={pending} aria-busy={pending || undefined}>
            {t("roadmap.fijar.save")}
          </Button>
          <Button block variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("roadmap.fijar.cancel")}
          </Button>
        </SheetActions>

        {onGiveDay && !done ? (
          <Row
            card
            name={t(giveDayLabel)}
            trailing={<ChevronRight size={16} aria-hidden />}
            rule={false}
            onClick={() => {
              onOpenChange(false);
              onGiveDay();
            }}
            disabled={pending}
          />
        ) : null}
        {mode === "edit" && canDelete ? <Separator /> : null}
        {mode === "edit" && canDelete ? (
          <Flex justify="start">
            <Button
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
                setDeleteOpen(true);
              }}
              disabled={pending}
            >
              {t("roadmap.fijar.delete")}
            </Button>
          </Flex>
        ) : null}
      </Sheet>
      {mode === "edit" && oneOffId ? (
        <OneOffDeleteSheet open={deleteOpen} onOpenChange={setDeleteOpen} oneOffId={oneOffId} name={current} />
      ) : null}
    </>
  );
}
