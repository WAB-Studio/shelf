"use client";

import { useFormatter, useTranslations } from "next-intl";

import { Flex, Heading, Link, Text } from "@/components/ui";
import { Link as LocaleLink } from "@/i18n/navigation";
import type { AlertChannel } from "@/lib/alert-channels";

// RF-251: per bank or card account, when its last alert arrived and how, so a channel that broke is seen in
// days, not at the end of the month. `nowIso` comes from the server so the relative time never differs on hydration.
export function AlertChannels({ channels, nowIso }: { channels: AlertChannel[]; nowIso: string }) {
  const t = useTranslations("webhooks.alertChannels");
  const format = useFormatter();
  const now = new Date(nowIso);

  if (channels.length === 0) return null;

  return (
    <Flex direction="column" gap="3">
      <Heading as="h2" size="3">{t("heading")}</Heading>
      <Flex direction="column" gap="3" asChild>
        <ul>
          {channels.map((channel) => (
            <Flex key={channel.accountId} direction="column" gap="1" asChild>
              <li>
                <Text size="2" weight="medium">{channel.accountName}</Text>
                <Text size="2" color="gray">
                  {channel.lastAlertAt === null || channel.lastVia === null
                    ? t("never")
                    : t("last", {
                        when: format.relativeTime(new Date(channel.lastAlertAt), now),
                        via: t(`via.${channel.lastVia}`),
                      })}
                </Text>
                {channel.status === "silent" && (
                  <Text size="2" color="orange">
                    {t("silent", { days: channel.daysSince ?? 0 })}
                  </Text>
                )}
                {channel.status === "never" && (
                  <Text size="2" color="gray">
                    {t("reconcileHint")}{" "}
                    <Link asChild size="2" weight="medium">
                      <LocaleLink prefetch={false} href="/settings/accounts">
                        {t("reconcileLink")}
                      </LocaleLink>
                    </Link>
                  </Text>
                )}
              </li>
            </Flex>
          ))}
        </ul>
      </Flex>
    </Flex>
  );
}
