import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { AccountsScreen } from "@/components/accounts/accounts-screen";
import { Page } from "@/components/ui";
import { listAccounts } from "@/db/queries/accounts";
import { listPendingAssetSettlements } from "@/db/queries/debt-statements";
import { getUserGroup } from "@/db/queries/groups";
import { routing } from "@/i18n/routing";
import { createAccountSchema } from "@/lib/validation/account";

export async function generateMetadata(
  props: PageProps<"/[locale]/settings/accounts">,
): Promise<Metadata> {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "accounts" });

  return { title: t("title") };
}

export default async function AccountsPage(
  props: PageProps<"/[locale]/settings/accounts">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  const { tab, new: requestedSubtype } = await props.searchParams;
  const archived = tab === "archived";

  // The dashboard's first-account tiles name the class to open the form with.
  // It is read through the create form's own field schema, so a fabricated value
  // is dropped here and the screen simply opens with no class chosen.
  const parsed = createAccountSchema.shape.subtype.safeParse(requestedSubtype);
  const newSubtype = parsed.success ? parsed.data : null;

  // The policies scope the rows: a personal-only caller sees only their own
  // accounts, a group member sees the group's too (RF-58).
  // The pending foreign estimates ride the same fan-out; an archived account is
  // read-only, so its tab asks for none.
  const [accounts, group, pending] = await Promise.all([
    listAccounts({ archived }),
    getUserGroup(),
    archived ? Promise.resolve([]) : listPendingAssetSettlements(),
  ]);

  return (
    <Page>
      <AccountsScreen
        accounts={accounts}
        groupName={group?.name ?? null}
        pendingSettlements={pending}
        archived={archived}
        newSubtype={newSubtype}
      />
    </Page>
  );
}
