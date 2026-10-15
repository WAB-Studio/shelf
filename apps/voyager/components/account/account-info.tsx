"use client";

import type { ReactNode } from "react";
import { useFormatter, useTranslations } from "next-intl";

import manifestJson from "@/public/dictionary/manifest.json";
import { manifestSchema } from "@/lib/dictionary/format";
import { POS_FREQUENCY_LICENCE_URL, POS_FREQUENCY_SOURCE_URL } from "@/lib/dictionary/pos-frequency-source";
import packageJson from "@/package.json";
import { Flex, Link, MetaLabel, Separator, TapTarget, Text } from "@/components/ui";

// Imported, not fetched: the manifest is on disk at build time (RNL-04),
// so this tab pays no request.
const manifest = manifestSchema.parse(manifestJson);

// `docs/voyager/SPEC.md`'s own model table reads the payload in MiB, so the
// figure here is 1024^2, not the decimal megabyte.
const BYTES_PER_MIB = 1024 * 1024;

// Each credit sits on its own row, a 44 px touch target that overlaps no other.
function Credit({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Flex>
      <Link href={href} target="_blank" rel="noreferrer">
        <TapTarget align="center">{children}</TapTarget>
      </Link>
    </Flex>
  );
}

/**
 * `CuentaInformacion` (`docs/voyager/DESIGN.md` "Settled"): the dictionary's
 * source, its edition and its CC BY-SA 3.0 licence, plus SUBTLEX-US's own
 * CC BY-NC-SA 4.0 credit for the sense order it feeds RL-43 — reachable
 * with no session because `/cuenta` already renders without one (RL-33),
 * which is what keeps every credit reachable by whoever uses the app, not
 * only the reader who happens to be signed in.
 */
export function AccountInfo() {
  const t = useTranslations("account.info");
  const format = useFormatter();
  const { source, counts, asset } = manifest;
  const sizeMib = `${format.number(asset.bytes / BYTES_PER_MIB, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MiB`;

  return (
    <Flex direction="column" gap="5">
      <Flex direction="column" gap="1">
        <MetaLabel>{t("dictionaryLabel")}</MetaLabel>
        {/* The name doubles as the source link RL-33 asks for: FreeDict is
            what is named, and what is linked. */}
        <Credit href={source.url}>
          <Text size="5" serif>
            {t("dictionaryName")}
          </Text>
        </Credit>
        <Text size="2" muted>
          {t("dictionaryStats", { entries: counts.entries, edition: source.edition, size: sizeMib })}
        </Text>
      </Flex>

      <Separator size="4" />

      <Flex direction="column" gap="1">
        <MetaLabel>{t("licenceLabel")}</MetaLabel>
        <Text size="2" as="p">
          {t("licenceBody")}
        </Text>
        <Credit href={source.licenceUrl}>{t("licenceName")}</Credit>
      </Flex>

      <Separator size="4" />

      <Flex direction="column" gap="1">
        <MetaLabel>{t("frequencyLabel")}</MetaLabel>
        <Text size="2" as="p">
          {t("frequencyBody")}
        </Text>
        <Credit href={POS_FREQUENCY_SOURCE_URL}>{t("frequencySource")}</Credit>
        <Credit href={POS_FREQUENCY_LICENCE_URL}>{t("frequencyLicence")}</Credit>
      </Flex>

      <Separator size="4" />

      <Flex direction="column" gap="1">
        <MetaLabel>{t("appLabel")}</MetaLabel>
        <Text size="2" muted>
          {t("appVersion", { version: packageJson.version })}
        </Text>
      </Flex>
    </Flex>
  );
}
