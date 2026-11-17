import { hasLocale } from "next-intl";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { AccountsScreen } from "@/components/accounts/accounts-screen";
import { Page } from "@/components/ui";
import { listReconcileAges } from "@/db/queries/account-reconciliations";
import { listAccounts } from "@/db/queries/accounts";
import { listPendingAssetSettlements } from "@/db/queries/debt-statements";
import { listCallerMembers } from "@/db/queries/group-members";
import { getUserGroup } from "@/db/queries/groups";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";
import { todayInBogota } from "@/lib/dates";
import { isStale } from "@/lib/reconcile-age";
import { openStatementRequests } from "@/lib/statement-cadence";
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
  const user = await requireUser();
  const today = todayInBogota();
  const [accounts, group, pending, roster, counts] = await Promise.all([
    listAccounts({ archived }),
    getUserGroup(),
    archived ? Promise.resolve([]) : listPendingAssetSettlements(),
    // The people a fund account can be held by (RF-181); an archived tab edits nothing and a caller
    // with no fund has no roster (the fund rides as a subselect). Archived members come too, so a holder
    // who left still reads by name.
    archived ? Promise.resolve([]) : listCallerMembers(user.id, { archived: "all" }),
    // When each account was last counted, for the quiet «Cuádrala» (RF-254); the archived tab shows none.
    archived ? Promise.resolve([]) : listReconcileAges(),
  ]);
  const requests = openStatementRequests(counts, today);
  const requested = new Set(requests.map((request) => request.accountId));
  const heldBy = new Set(accounts.map((account) => account.holderMemberId));
  const members = roster.filter((member) => !member.archivedAt || heldBy.has(member.id));

  return (
    <Page>
      <AccountsScreen
        accounts={accounts}
        groupName={group?.name ?? null}
        pendingSettlements={pending}
        archived={archived}
        newSubtype={newSubtype}
        members={members.map((member) => ({ id: member.id, name: member.name }))}
        staleIds={counts.filter((row) => isStale(row, today) && !requested.has(row.id)).map((row) => row.id)}
        requests={requests}
      />
    </Page>
  );
}
