"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { createKey, revokeKey } from "@/app/actions/keys";
import { keyNameSchema } from "@/lib/forms";
import { Between, Button, Code, Form, Input, Stack, Text, TextLink } from "@/components/ui";

// ActivityWatch with aw-timelog bundled (RT-10): the latest release of our fork.
const INSTALLER_URL = "https://github.com/WAB-Studio/activitywatch/releases/latest";

export type KeyLine = { id: string; name: string; when: string | null; revoked: boolean };

// «Llaves» (RT-06, RT-10): create one, see it once with its command, revoke one; the installer to paste it in.
export function KeysPanel({ keys, siteUrl }: { keys: KeyLine[]; siteUrl: string }) {
  const t = useTranslations("time.keys");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<"nameInvalid" | "signedOut" | "revokeFailed" | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!keyNameSchema.safeParse(name).success) {
      setError("nameInvalid");
      return;
    }
    startTransition(async () => {
      const result = await createKey(name);
      setError(result.ok ? null : result.error);
      if (result.ok) {
        setFresh(result.key);
        setName("");
        setCopied(false);
      }
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      const result = await revokeKey(id);
      setError(result.ok ? null : "revokeFailed");
    });
  }

  async function copy() {
    if (fresh === null) return;
    await navigator.clipboard.writeText(fresh);
    setCopied(true);
  }

  return (
    <Stack gap={4}>
      <Text as="p" variant="meta">{t("intro")}</Text>
      <Stack gap={1}>
        <Text as="p">{t("install")}</Text>
        <TextLink href={INSTALLER_URL}>{t("download")} ›</TextLink>
      </Stack>
      <Form onSubmit={submit}>
        <Input
          aria-label={t("name")}
          placeholder={t("namePlaceholder")}
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={pending}>
          {pending ? t("creating") : t("create")}
        </Button>
      </Form>
      {error ? <Text as="p">{t(error)}</Text> : null}
      {fresh !== null ? (
        <Stack gap={2}>
          <Text as="p">{t("shown")}</Text>
          <Code>{fresh}</Code>
          <Between>
            <Text variant="meta">{t("command")}</Text>
            <Button type="button" quiet onClick={copy}>
              {copied ? t("copied") : t("copy")}
            </Button>
          </Between>
          <Code>{`py -m aw_client timelog --url ${siteUrl} --key ${fresh}`}</Code>
        </Stack>
      ) : null}
      {keys.length === 0 ? (
        <Text as="p" variant="meta">{t("none")}</Text>
      ) : (
        <Stack gap={1}>
          {keys.map((key) => (
            <Between key={key.id}>
              <Stack gap={1}>
                <Text>{key.name}</Text>
                <Text variant="meta">{key.revoked ? t("revoked") : key.when === null ? t("unused") : t("used", { when: key.when })}</Text>
              </Stack>
              {key.revoked ? null : (
                <Button type="button" quiet aria-label={t("revokeLabel", { name: key.name })} onClick={() => revoke(key.id)}>
                  {t("revoke")}
                </Button>
              )}
            </Between>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
