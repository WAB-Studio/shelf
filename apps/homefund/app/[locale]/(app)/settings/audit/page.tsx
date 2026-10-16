import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";

import { AuditScreen } from "@/components/audit/audit-screen";
import { Page } from "@/components/ui";
import { getAuditFilterOptions, listAuditLog } from "@/db/queries/audit-log";
import type { AuditLogFilters } from "@/db/queries/audit-log";
import { requireUser } from "@/db/session";
import { isCivilDate } from "@/lib/dates";
import { routing } from "@/i18n/routing";

// The viewer reads every filter from the URL, so a malformed value never reaches
// Postgres: a bad date or a repeated key drops to undefined, a bad page to 1.
const civilDate = z
  .string()
  .refine(isCivilDate)
  .catch(() => undefined as unknown as string)
  .optional();

const nonEmpty = z
  .string()
  .min(1)
  .catch(() => undefined as unknown as string)
  .optional();

const searchParamsSchema = z.object({
  entity: nonEmpty,
  actor: nonEmpty,
  from: civilDate,
  to: civilDate,
  page: z.coerce.number().int().min(1).catch(1),
});

const PAGE_SIZE = 25;

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/audit">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "audit" });

  return { title: t("title") };
}

export default async function AuditPage(
  props: PageProps<"/[locale]/settings/audit">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const parsed = searchParamsSchema.parse(await props.searchParams);

  const filters: AuditLogFilters = {
    entity: parsed.entity,
    actorUserId: parsed.actor,
    from: parsed.from,
    to: parsed.to,
    limit: PAGE_SIZE,
    offset: (parsed.page - 1) * PAGE_SIZE,
  };

  // The guard fans out with the reads it protects, never ahead of them.
  const [, { rows, total }, options] = await Promise.all([
    requireUser(),
    listAuditLog(filters),
    getAuditFilterOptions(),
  ]);

  return (
    <Page>
      <AuditScreen
        rows={rows}
        total={total}
        pageSize={PAGE_SIZE}
        options={options}
        filters={{
          entity: parsed.entity ?? null,
          actor: parsed.actor ?? null,
          from: parsed.from ?? null,
          to: parsed.to ?? null,
          page: parsed.page,
        }}
      />
    </Page>
  );
}
