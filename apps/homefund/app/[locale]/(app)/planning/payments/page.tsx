import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";

import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

// «Pagos», «Recurrentes» and «Suscripciones» became one screen, «Lo que viene».
export default async function PaymentsRedirect(
  props: PageProps<"/[locale]/planning/payments">,
) {
  const { locale } = await props.params;
  if (!hasLocale(routing.locales, locale)) notFound();

  redirect({ href: "/planning/upcoming", locale });
}
