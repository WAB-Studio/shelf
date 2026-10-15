import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { z } from "zod";

import { CategoriesScreen } from "@/components/categories/categories-screen";
import { Page } from "@/components/ui";
import {
  listCategories,
  listParentCategories,
  listUsedCategoryColors,
} from "@/db/queries/categories";
import type { CategoryScope } from "@/db/queries/categories";
import { getUserGroup, getUserGroupRole } from "@/db/queries/groups";
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

  // The scope is the caller's group when they belong to one, otherwise their
  // personal set (RF-63). Both kinds count toward the default colour.
  const [user, group] = await Promise.all([requireUser(), getUserGroup()]);
  const scope: CategoryScope = group
    ? { groupId: group.id }
    : { ownerUserId: user.id };

  // The desktop table draws both scopes at once (RF-63, RF-70): a grouped
  // caller's personal set is invisible to `categories` below, so it costs one
  // more read; an ungrouped caller's personal set is `categories` itself, and
  // reading it twice would waste a round trip for the common case (RNF-09).
  const [categories, parents, usedColors, personal, role] = await Promise.all([
    listCategories(scope, kind),
    listParentCategories(scope, kind),
    listUsedCategoryColors(scope),
    group ? listCategories({ ownerUserId: user.id }, kind) : Promise.resolve(null),
    group ? getUserGroupRole() : Promise.resolve(null),
  ]);
  const groupCategories = group ? categories : [];
  const personalCategories = personal ?? categories;

  return (
    <Page>
      <CategoriesScreen
        kind={kind}
        categories={categories}
        personal={personalCategories}
        group={groupCategories}
        groupName={group?.name ?? null}
        canManageGroup={role === "leader"}
        parents={parents}
        usedColors={usedColors}
      />
    </Page>
  );
}
