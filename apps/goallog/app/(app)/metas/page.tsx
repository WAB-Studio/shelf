import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Button, Text } from "@/components/ui";
import { GoalsScreen } from "@/components/goal/goals-screen";
import { listGoalsForMetas, listLooseCommitments } from "@/lib/queries/goal";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.titles");
  return { title: t("goals") };
}

// A person with goals sees them listed one with the other — never a redirect
// past a single one (RP-11). With no goal ever, open, ended or archived, the
// screen draws `MetasVacio` (RP-37); an all-archived person still gets the list.
export default async function GoalsIndexPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  const [{ open, ended, archived }, habits, t] = await Promise.all([
    listGoalsForMetas(),
    listLooseCommitments(),
    getTranslations("connections.entry"),
  ]);
  const connect = (
    <Button asChild variant="quiet" block stack>
      <Link href="/conexiones">
        {t("title")}
        <Text variant="sentence">{t("hint")}</Text>
      </Link>
    </Button>
  );
  return (
    <GoalsScreen
      open={open}
      ended={ended}
      archived={archived}
      habits={habits}
      connect={connect}
      email={person.email}
    />
  );
}
