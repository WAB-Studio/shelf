import { getTranslations } from "next-intl/server";

import { ClassRows, Composition, Section, Stat, Stats } from "@/components/ui";
import type { AppClass } from "@/lib/app-classes";
import type { calendarWords } from "@/lib/words";

type Words = Awaited<ReturnType<typeof calendarWords>>;
type ClassTime = { kind: AppClass; seconds: number };

// The four figures a day or a week opens with (RT-35): its total, its main class, its top app and Claude, then the class bar.
export async function Overview({ total, apps, classes, top, claude, words }: { total: number; apps: number; classes: ClassTime[]; top: { name: string; seconds: number }; claude: { screen: number; agent: number }; words: Words }) {
  const [t, tClass] = await Promise.all([getTranslations("time.today"), getTranslations("time.classes")]);
  const main = classes[0];
  const share = (seconds: number) => Math.round((seconds / Math.max(1, total)) * 100);
  const claudeSeen = claude.screen > 0 || claude.agent > 0;
  return (
    <>
      <Stats label={t("statsLabel")}>
        <Stat label={t("statTotal")} value={words.duration(total)} note={t("statTotalNote", { n: apps })} />
        {main === undefined ? null : <Stat label={t("statClass")} value={tClass(main.kind)} tone={main.kind} note={t("statClassNote", { duration: words.duration(main.seconds), share: share(main.seconds) })} />}
        <Stat label={t("statApp")} value={top.name} note={words.duration(top.seconds)} />
        <Stat label={t("statClaude")} value={claudeSeen ? words.duration(claude.agent) : "—"} tone="claude" note={claudeSeen ? t("statClaudeNote", { screen: words.duration(claude.screen) }) : t("statClaudeNone")} />
      </Stats>
      <Composition label={t("byClassLabel")} parts={classes.map((one) => ({ key: one.kind, tone: one.kind, seconds: one.seconds }))} />
    </>
  );
}

// «Por clase»: every class written with its share and its time, longest first.
export async function ClassSection({ total, classes, words }: { total: number; classes: ClassTime[]; words: Words }) {
  const [t, tClass] = await Promise.all([getTranslations("time.today"), getTranslations("time.classes")]);
  return (
    <Section panel title={t("byClass")}>
      <ClassRows rows={classes.map((one) => ({ key: one.kind, tone: one.kind, name: tClass(one.kind), share: `${Math.round((one.seconds / Math.max(1, total)) * 100)} %`, figure: words.duration(one.seconds) }))} />
    </Section>
  );
}
