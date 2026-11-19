"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { createKey, revokeKey } from "@/app/actions/keys";
import { keyNameSchema } from "@/lib/forms";
import { INSTALLER_URL } from "@/lib/installer";
import { Between, Button, Code, CodeBlock, Confirm, Disclosure, Field, Form, Stack, Text, TextLink } from "@/components/ui";

export type KeyLine = { id: string; name: string; when: string | null; revoked: boolean };

// «Llaves» (RT-06, RT-10): create one, see it once with its command, revoke one; the installer to paste it in.
export function KeysPanel({ keys, siteUrl }: { keys: KeyLine[]; siteUrl: string }) {
  const t = useTranslations("time.keys");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ id: string; key: string } | null>(null);
  const [error, setError] = useState<"nameInvalid" | "signedOut" | "revokeFailed" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
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
        setFresh({ id: result.id, key: result.key });
        setName("");
      }
    });
  }

  function revoke(id: string) {
    setConfirming(null);
    startTransition(async () => {
      const result = await revokeKey(id);
      setError(result.ok ? null : "revokeFailed");
      // A key just revoked is a key that no longer works: its copy and commands go with it.
      if (result.ok) setFresh((shown) => (shown?.id === id ? null : shown));
    });
  }

  const mcpUrl = `${siteUrl.replace(/\/$/, "")}/mcp`;
  // The key is shown once and never read back: after that the block carries a placeholder to fill in.
  const claudeKey = fresh === null ? t("keyPlaceholder") : fresh.key;

  return (
    <Stack gap={4}>
      <Form onSubmit={submit}>
        <Field
          label={t("name")}
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
          <CopyBlock key={fresh.key} label={t("keyBlock")} action={t("copyKey")} value={fresh.key} />
          <CopyBlock key={`command-${fresh.key}`} label={t("command")} action={t("copyCommand")} value={`py -m aw_client timelog --url ${siteUrl} --key ${fresh.key}`} />
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
              {key.revoked ? null : confirming === key.id ? (
                <Confirm>
                  <Text variant="meta">{t("confirmRevoke", { name: key.name })}</Text>
                  <Button type="button" danger disabled={pending} onClick={() => revoke(key.id)}>
                    {t("confirmYes")}
                  </Button>
                  <Button type="button" quiet onClick={() => setConfirming(null)}>
                    {t("confirmNo")}
                  </Button>
                </Confirm>
              ) : (
                <Button type="button" quietDanger aria-label={t("revokeLabel", { name: key.name })} onClick={() => setConfirming(key.id)}>
                  {t("revoke")}
                </Button>
              )}
            </Between>
          ))}
        </Stack>
      )}
      <Stack gap={1}>
        <Text as="p">{t("install")}</Text>
        <TextLink button href={INSTALLER_URL}>{t("download")}</TextLink>
      </Stack>
      <Disclosure summary={<Text>{t("claudeTitle")}</Text>}>
        <Stack gap={2}>
          <Text as="p" variant="meta">{t("claudeIntro")}</Text>
          <CopyBlock key={`claude-${claudeKey}`} label={t("claudeCommand")} action={t("copyClaudeCommand")} value={`claude mcp add --transport http timelog ${mcpUrl} --header "Authorization: Bearer ${claudeKey}"`} />
          {fresh === null ? <Text as="p" variant="meta">{t("claudeKeyHint")}</Text> : null}
        </Stack>
      </Disclosure>
    </Stack>
  );
}

// One block and the button that copies exactly it, on one row.
function CopyBlock({ label, action, value }: { label: string; action: string; value: string }) {
  const t = useTranslations("time.keys");
  const [copied, setCopied] = useState<boolean | "failed">(false);

  // The clipboard refuses outside a secure page or when the browser denies it.
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied("failed");
    }
  }

  return (
    <Stack gap={1}>
      <Text variant="meta">{label}</Text>
      <CodeBlock row>
        <Code>{value}</Code>
        <Button type="button" quiet onClick={copy} aria-label={action}>
          {copied === true ? t("copied") : t("copy")}
        </Button>
      </CodeBlock>
      {copied === "failed" ? <Text as="p">{t("copyFailed")}</Text> : null}
    </Stack>
  );
}
