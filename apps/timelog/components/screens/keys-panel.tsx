"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { createKey, revokeKey } from "@/app/actions/keys";
import { Between, Button, Code, Form, Input, Stack, Text } from "@/components/ui";

export type KeyLine = { id: string; name: string; when: string | null; revoked: boolean };

// «Llaves» (RT-06): create one, see it once with its command, revoke one.
export function KeysPanel({ keys, siteUrl }: { keys: KeyLine[]; siteUrl: string }) {
  const t = useTranslations("time.keys");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createKey(name);
      setError(!result.ok);
      if (result.ok) {
        setFresh(result.key);
        setName("");
        setCopied(false);
      }
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
      {error ? <Text as="p" variant="meta">{t("nameInvalid")}</Text> : null}
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
          <Code>{`aw-client timelog --url ${siteUrl} --key ${fresh}`}</Code>
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
                <Button type="button" quiet aria-label={t("revokeLabel", { name: key.name })} onClick={() => startTransition(async () => void (await revokeKey(key.id)))}>
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
