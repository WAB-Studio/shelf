"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { createKey, revokeKey } from "@/app/actions/keys";
import { keyNameSchema } from "@/lib/forms";
import { Between, Button, Code, CodeBlock, Confirm, Field, Form, Stack, Text, TextLink } from "@/components/ui";

// ActivityWatch with aw-timelog bundled (RT-10): the latest release of our fork.
const INSTALLER_URL = "https://github.com/WAB-Studio/activitywatch/releases/latest";

export type KeyLine = { id: string; name: string; when: string | null; revoked: boolean };

// «Llaves» (RT-06, RT-10): create one, see it once with its command, revoke one; the installer to paste it in.
export function KeysPanel({ keys, siteUrl }: { keys: KeyLine[]; siteUrl: string }) {
  const t = useTranslations("time.keys");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
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
        setFresh(result.key);
        setName("");
      }
    });
  }

  function revoke(id: string) {
    setConfirming(null);
    startTransition(async () => {
      const result = await revokeKey(id);
      setError(result.ok ? null : "revokeFailed");
    });
  }

  return (
    <Stack gap={4}>
      <Text as="p" variant="meta">{t("intro")}</Text>
      <Stack gap={1}>
        <Text as="p">{t("install")}</Text>
        <TextLink button href={INSTALLER_URL}>{t("download")}</TextLink>
      </Stack>
      <Form onSubmit={submit}>
        <Field
          label={t("name")}
          placeholder={t("namePlaceholder")}
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" quiet disabled={pending}>
          {pending ? t("creating") : t("create")}
        </Button>
      </Form>
      {error ? <Text as="p">{t(error)}</Text> : null}
      {fresh !== null ? (
        <Stack gap={2}>
          <Text as="p">{t("shown")}</Text>
          <CopyBlock key={fresh} label={t("keyBlock")} action={t("copyKey")} value={fresh} />
          <CopyBlock key={`command-${fresh}`} label={t("command")} action={t("copyCommand")} value={`py -m aw_client timelog --url ${siteUrl} --key ${fresh}`} />
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
    </Stack>
  );
}

// One block and the button that copies exactly it.
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
    <CodeBlock>
      <Between>
        <Text variant="meta">{label}</Text>
        <Button type="button" quiet onClick={copy} aria-label={action}>
          {copied === true ? t("copied") : t("copy")}
        </Button>
      </Between>
      <Code>{value}</Code>
      {copied === "failed" ? <Text as="p">{t("copyFailed")}</Text> : null}
    </CodeBlock>
  );
}
