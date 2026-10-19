import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AppSidebar } from "@/components/fund/app-sidebar";
import { AppTabs } from "@/components/fund/app-tabs";
import { QuickEntryProvider } from "@/components/transactions/quick-entry-provider";
import { Box, Flex, Separator, Text } from "@/components/ui";
import { getShellSummary } from "@/db/queries/app-shell";
import { getTransactionFormOptions } from "@/db/queries/transaction-form";
import { requireUser } from "@/db/session";
import { routing } from "@/i18n/routing";

// Written by `proxy.ts` under this name, on every request it matches.
const PATHNAME_HEADER = "x-pathname";

/**
 * The routes that presume a fund, listed here instead of guarded in their own
 * page. `loading.tsx` wraps every page of this group in a Suspense boundary, and
 * a fallback that renders commits the response to 200 before the page runs, so a
 * page's `notFound()` can no longer answer 404. The boundary does not wrap the
 * layout of its own segment, which leaves this the last place a status can still
 * be set.
 */
const GROUP_ONLY_ROUTES = ["/settings/members", "/settings/group"];

// The path without its locale, which is how the list above is written.
function routeOf(pathname: string, locale: string): string {
  const route = pathname.startsWith(`/${locale}`)
    ? pathname.slice(locale.length + 1)
    : pathname;

  return route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
}

/**
 * The signed-in shell. The route group carries the guard, so every route added
 * under it inherits it without a second check. There is no fund to switch (RF-55):
 * the caller's optional group is resolved once here and named in the shell.
 *
 * The sidebar owns navigation from `md` up and the bottom bar owns it below; the
 * two never render together.
 */
export default async function AppLayout(props: LayoutProps<"/[locale]">) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();


  // The proxy already redirected an anonymous visitor; this is what enforces it.
  // Quick-entry options are fetched here so every route opens the sheet or form
  // without a second round trip (RF-22).
  const [user, options, summary, t, requestHeaders] = await Promise.all([
    requireUser(),
    getTransactionFormOptions(),
    getShellSummary(),
    getTranslations("common"),
    headers(),
  ]);

  const group = summary.group;

  // RF-55: a personal-only caller reaches every other screen, and this refusal
  // rides the group already read above rather than a second query. The page keeps
  // its own check: without the header there is nothing to match, and the screen
  // still refuses — over a 200, as it does today.
  const route = routeOf(requestHeaders.get(PATHNAME_HEADER) ?? "", locale);
  const needsGroup = GROUP_ONLY_ROUTES.some(
    (one) => route === one || route.startsWith(`${one}/`),
  );
  if (!group && needsGroup) notFound();

  const fundName = group?.name ?? t("appName");

  return (
    <QuickEntryProvider options={options}>
      <Flex flexGrow="1">
        <AppSidebar
          fundName={fundName}
          hasGroup={group !== null}
          personName={summary.memberName ?? user.email}
          role={summary.role}
          pendingCount={summary.pendingDeliveries}
        />
        <Flex direction="column" flexGrow="1" minWidth="0">
          {/* The sidebar names the fund from `md` up, so the bar is the phone's alone. */}
          <Box display={{ initial: "block", md: "none" }}>
            <Flex asChild align="center" gap="2" px="3" py="2">
              <header>
                <Text weight="bold" truncate>
                  {fundName}
                </Text>
              </header>
            </Flex>
            <Separator size="4" />
          </Box>
          {props.children}
        </Flex>
      </Flex>
      <Box display={{ initial: "block", md: "none" }}>
        <AppTabs hasGroup={group !== null} />
      </Box>
    </QuickEntryProvider>
  );
}
