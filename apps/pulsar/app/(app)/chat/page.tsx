import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { ChatScreen } from "@/components/chat/chat-screen";
import { getPerson } from "@/lib/session";

// Static per route: no title reads a goal or costs a statement (RNP-01).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("chat");
  return { title: t("title") };
}

// The auth gate and nothing else: the conversation lives in the tab (RP-94).
export default async function ChatPage() {
  const person = await getPerson();
  if (!person) redirect("/entrar");

  return <ChatScreen />;
}
