import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Button, Text } from "@/components/ui";

// A day with no goal ever (`HoyVacioImportar.dc.html`): the two ways a person
// starts, opening one by hand or bringing the plan already written. It reads
// its own words so `day-screen.tsx` passes it nothing.
export async function EmptyDay() {
  const t = await getTranslations("day.empty");
  return (
    <>
      <Text as="p" variant="title">
        {t("title")}
      </Text>
      <Text as="p" variant="sentence">
        {t("body")}
      </Text>
      <Button asChild block>
        <Link href="/metas/nueva">{t("action")}</Link>
      </Button>
      <Button asChild block variant="outline">
        <Link href="/metas/importar">{t("import")}</Link>
      </Button>
    </>
  );
}
