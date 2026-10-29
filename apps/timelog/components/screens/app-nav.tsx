"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { Nav, TextLink } from "@/components/ui";

// «Hoy», «Semana», «Llaves»: at the foot on the phone, under the title on the desktop.
export function AppNav() {
  const t = useTranslations("time.nav");
  const path = usePathname();
  const links = [
    { href: "/", label: t("today") },
    { href: "/semana", label: t("week") },
    { href: "/llaves", label: t("keys") },
  ];
  return (
    <Nav label={t("label")}>
      {links.map((link) => (
        <TextLink key={link.href} href={link.href} current={path === link.href}>
          {link.label}
        </TextLink>
      ))}
    </Nav>
  );
}
