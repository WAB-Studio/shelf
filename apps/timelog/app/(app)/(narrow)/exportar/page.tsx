import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Button, Field, Form, Stack, Text, TextLink, Title } from "@/components/ui";
import { mondayOf } from "@/lib/week";
import { addDays, civilDay } from "@/lib/zone";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("time.export");
  return { title: t("title") };
}

// «Exportar» (RT-15): the daily CSV over a range. The form is a plain GET, so the download needs no script.
export default async function ExportPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const today = civilDay();
  const [{ error }, t] = await Promise.all([searchParams, getTranslations("time.export")]);
  const monday = mondayOf(today);
  const shortcuts = [
    { key: "thisWeek" as const, from: monday, to: addDays(monday, 6) },
    { key: "last30" as const, from: addDays(today, -29), to: today },
    { key: "thisMonth" as const, from: `${today.slice(0, 8)}01`, to: today },
  ];
  return (
    <Stack gap={4}>
      <TextLink href="/semana">‹ {t("back")}</TextLink>
      <Title>{t("title")}</Title>
      <Text as="p">{t("intro")}</Text>
      <Form action="/api/export" method="get">
        <Field label={t("from")} name="from" type="date" defaultValue={addDays(today, -29)} required />
        <Field label={t("to")} name="to" type="date" defaultValue={today} required />
        <Button type="submit">{t("download")}</Button>
      </Form>
      {error === "range" ? <Text as="p">{t("badRange")}</Text> : null}
      <Stack gap={2}>
        <Text variant="meta">{t("quick")}</Text>
        <Stack gap={1}>
          {shortcuts.map((one) => (
            <TextLink key={one.key} download href={`/api/export?from=${one.from}&to=${one.to}`}>
              {t(one.key)} ›
            </TextLink>
          ))}
        </Stack>
      </Stack>
    </Stack>
  );
}
