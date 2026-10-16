import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";

import { CategoriesScreen } from "@/components/categories/categories-screen";
import { Page } from "@/components/ui";
import { getCategoriesScreenData } from "@/db/queries/categories";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import { CATEGORY_KINDS } from "@/lib/validation/category";

// A mistyped tab is not a missing page: an unknown `kind` opens `expense`, not a 404.
function parseKind(value: string | string[] | undefined) {
  const result = z.enum(CATEGORY_KINDS).safeParse(value);
  return result.success ? result.data : "expense";
}

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/categories">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "categories" });

  return { title: t("title") };
}

export default async function CategoriesPage(
  props: PageProps<"/[locale]/settings/categories">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const { kind: kindParam } = await props.searchParams;
  const kind = parseKind(kindParam);

  const [, data] = await Promise.all([
    requireUser(),
    getCategoriesScreenData(kind),
  ]);

  return (
    <Page>
      <CategoriesScreen
        kind={kind}
        categories={data.categories}
        personal={data.personal}
        group={data.group}
        groupName={data.groupName}
        canManageGroup={data.isLeader}
        parents={data.parents}
        usedColors={data.usedColors}
      />
    </Page>
  );
}
