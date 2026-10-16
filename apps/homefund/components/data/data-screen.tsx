"use client";

import { CheckCircle2, Download, FileSpreadsheet, Upload } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { commitImportAction, previewImportAction } from "@/app/actions/import";
import { ImportErrorsTable } from "@/components/data/import-errors-table";
import type { CommitRowFailure } from "@/db/queries/import-commit";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  FilterField,
  Flex,
  Heading,
  Spinner,
  Switch,
  Table,
  TapTarget,
  Text,
  TextField,
} from "@/components/ui";
import type { SheetEntity } from "@/lib/spreadsheet/schema";
import { useActionErrorToast, type MessageKey } from "@/lib/use-action-toast";

// The commit action JSON-encodes a row failure into its one error string
// (`CommitRowFailure`); anything else is a plain catalogue key, `errors.unexpected`
// included, so a decode failure here is not a bug — it is every other error path.
function parseCommitRowFailure(serverError: string | undefined): CommitRowFailure | null {
  if (!serverError) return null;
  try {
    const parsed: unknown = JSON.parse(serverError);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CommitRowFailure).entity === "string" &&
      typeof (parsed as CommitRowFailure).sheetRow === "number" &&
      typeof (parsed as CommitRowFailure).reasonKey === "string"
    ) {
      return parsed as CommitRowFailure;
    }
  } catch {
    // Not JSON: a plain key, left to the generic toast below.
  }
  return null;
}

/**
 * The export half of the Data screen (RF-49, RF-50). The entity picks and the
 * optional civil-date range compose the query the export route reads; the
 * template route ignores both. Each action is a plain anchor so the browser runs
 * a real file download instead of a client navigation.
 */
export function DataScreen({
  entities,
}: {
  entities: readonly SheetEntity[];
}) {
  const t = useTranslations("data");
  // Root-scoped: a row's error is a full catalogue key from another namespace.
  const tKey = useTranslations();
  const locale = useLocale();

  const [selected, setSelected] = useState<Set<SheetEntity>>(
    () => new Set(entities),
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  function toggle(entity: SheetEntity, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(entity);
      else next.delete(entity);
      return next;
    });
  }

  // Only picked entities and set bounds ride the query; an empty selection drops
  // its key so the route falls back to all five (RF-50).
  const exportQuery = new URLSearchParams();
  const picked = entities.filter((entity) => selected.has(entity));
  if (picked.length > 0) exportQuery.set("entities", picked.join(","));
  if (from) exportQuery.set("from", from);
  if (to) exportQuery.set("to", to);
  const query = exportQuery.toString();

  const exportHref = `/${locale}/settings/data/export${query ? `?${query}` : ""}`;
  const templateHref = `/${locale}/settings/data/template`;

  // The chosen file drives both the preview and the later commit; a ref clears the
  // native input on reset, which no controlled value can do for a file field.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);

  const onImportError = useActionErrorToast();

  const preview = useAction(previewImportAction, { onError: onImportError });
  const commit = useAction(commitImportAction, {
    onSuccess: () => {
      toast.success(t("screen.importDone"));
      resetImport();
    },
    // A commit that dies mid-write names the row it choked on (RF-51): the whole
    // write still rolled back, so this is the one place a person learns why.
    onError: ({ error }) => {
      const failure = parseCommitRowFailure(error.serverError);
      if (!failure) {
        onImportError({ error });
        return;
      }
      toast.error(
        t("screen.commitRowError", {
          row: failure.sheetRow,
          sheet: t(`sheets.${failure.entity}`),
          reason: tKey(failure.reasonKey as MessageKey),
        }),
      );
    },
  });

  function fileForm(chosen: File) {
    const body = new FormData();
    body.set("file", chosen);
    return body;
  }

  function resetImport() {
    setFile(null);
    preview.reset();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // A fresh pick supersedes the last preview, so drop it before validating anew.
  function onFileChange(chosen: File | null) {
    setFile(chosen);
    preview.reset();
    if (chosen) preview.execute(fileForm(chosen));
  }

  const importPreview = preview.result.data;
  // The gate: confirm writes only once every row across every sheet passed.
  const canConfirm = !!importPreview && importPreview.totals.error === 0;

  // Every sheet's errored rows in one flat run, each error its own line: the
  // desktop table names the sheet a row belongs to instead of grouping by it.
  // The column and the raw value ride straight from the pipeline (RF-51); only
  // the column's own header and the message key still need translating here.
  const errorRows = importPreview
    ? importPreview.perEntity.flatMap((entity) =>
        entity.rows
          .filter((row) => row.errors.length > 0)
          .flatMap((row) =>
            row.errors.map((error, position) => ({
              key: `${entity.entity}-${row.index}-${position}`,
              sheet: t(`sheets.${entity.entity}`),
              sheetRow: row.sheetRow,
              column: error.column
                ? tKey(`data.columns.${error.column}` as MessageKey)
                : null,
              value: error.value,
              problem: tKey(error.key as MessageKey),
            })),
          ),
      )
    : [];

  return (
    <Flex direction="column" gap="4">
      <Heading size="5">{t("screen.title")}</Heading>

      <Card>
        <Flex direction="column" gap="4">
          <Heading as="h2" size="3">{t("screen.exportHeading")}</Heading>

          <Flex direction="column" gap="1">
            <Text size="2" weight="medium" color="gray">
              {t("screen.entitiesLabel")}
            </Text>
            <Flex direction="column" gap="2" mt="1">
              {entities.map((entity) => (
                <Text key={entity} as="label" size="2">
                  {/* The label is what a finger lands on, and a switch is shorter
                      than the floor; the row carries it for the pair. */}
                  <TapTarget align="center" gap="2">
                    <Switch
                      checked={selected.has(entity)}
                      onCheckedChange={(checked) => toggle(entity, checked)}
                    />
                    {t(`sheets.${entity}`)}
                  </TapTarget>
                </Text>
              ))}
            </Flex>
          </Flex>

          <Flex gap="3" wrap="wrap">
            <FilterField label={t("screen.rangeFrom")}>
              {(id) => (
                <TextField.Root
                  id={id}
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              )}
            </FilterField>
            <FilterField label={t("screen.rangeTo")}>
              {(id) => (
                <TextField.Root
                  id={id}
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              )}
            </FilterField>
          </Flex>

          <Button asChild>
            <a href={exportHref}>
              <Download size={16} />
              {t("screen.download")}
            </a>
          </Button>
        </Flex>
      </Card>

      <Card>
        <Flex direction="column" gap="3">
          <Heading as="h2" size="3">{t("screen.templateHeading")}</Heading>
          <Text size="2" color="gray">
            {t("screen.templateDescription")}
          </Text>
          <Button asChild variant="soft">
            <a href={templateHref}>
              <FileSpreadsheet size={16} />
              {t("screen.downloadTemplate")}
            </a>
          </Button>
        </Flex>
      </Card>

      <Card>
        <Flex direction="column" gap="4">
          <Heading as="h2" size="3">{t("screen.importHeading")}</Heading>
          <Text size="2" color="gray">
            {t("screen.importDescription")}
          </Text>

          <Flex direction="column" gap="1">
            <Text size="2" weight="medium" color="gray">
              {t("screen.fileLabel")}
            </Text>
            <Flex align="center" gap="2">
              {/* Radix has no file field, so a native input carries the pick behind
                  the scenes: `display: none` drops it from the accessibility tree
                  and the tab order both, and a real button — the thing a person
                  sees and touches — is what opens it, by ref, on click or on Enter
                  and Space, which a `<label>` wrapper never forwarded to a key. */}
              <Button
                type="button"
                variant="soft"
                color="gray"
                disabled={commit.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={16} />
                {t("screen.chooseFile")}
              </Button>
              <Box display="none">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  disabled={commit.isPending}
                  onChange={(event) =>
                    onFileChange(event.target.files?.[0] ?? null)
                  }
                />
              </Box>
              {file && (
                <Text size="2" color="gray">
                  {file.name}
                </Text>
              )}
            </Flex>
          </Flex>

          {preview.isPending && (
            <Flex align="center" gap="2">
              <Spinner />
              <Text size="2" color="gray">
                {t("screen.importChecking")}
              </Text>
            </Flex>
          )}

          {importPreview && !preview.isPending && (
            <Flex direction="column" gap="4">
              <Flex gap="2" wrap="wrap">
                <Badge color="green" size="2">
                  {t("screen.totalsNew", { count: importPreview.totals.new })}
                </Badge>
                <Badge color="blue" size="2">
                  {t("screen.totalsUpdate", {
                    count: importPreview.totals.update,
                  })}
                </Badge>
                <Badge
                  color={importPreview.totals.error > 0 ? "red" : "gray"}
                  size="2"
                >
                  {t("screen.totalsError", {
                    count: importPreview.totals.error,
                  })}
                </Badge>
              </Flex>

              {importPreview.totals.error > 0 ? (
                <>
                  {/* The phone keeps the per-sheet tables it already had; the
                      laptop gets one flat table naming the sheet per row. */}
                  <Box display={{ initial: "block", lg: "none" }}>
                    <Flex direction="column" gap="4">
                      {importPreview.perEntity
                        .filter((entity) =>
                          entity.rows.some((row) => row.errors.length > 0),
                        )
                        .map((entity) => (
                          <Flex key={entity.entity} direction="column" gap="1">
                            <Text size="2" weight="medium">
                              {t(`sheets.${entity.entity}`)}
                            </Text>
                            <Table.Root size="1" variant="surface">
                              <Table.Header>
                                <Table.Row>
                                  <Table.ColumnHeaderCell>
                                    {t("screen.reportRow")}
                                  </Table.ColumnHeaderCell>
                                  <Table.ColumnHeaderCell>
                                    {t("screen.reportProblem")}
                                  </Table.ColumnHeaderCell>
                                </Table.Row>
                              </Table.Header>
                              <Table.Body>
                                {entity.rows
                                  .filter((row) => row.errors.length > 0)
                                  .map((row) => (
                                    <Table.Row key={row.index}>
                                      <Table.RowHeaderCell>
                                        {row.sheetRow}
                                      </Table.RowHeaderCell>
                                      <Table.Cell>
                                        <Flex direction="column" gap="1">
                                          {row.errors.map((error, position) => (
                                            <Text
                                              key={`${error.key}-${position}`}
                                              size="2"
                                            >
                                              {tKey(error.key as MessageKey)}
                                            </Text>
                                          ))}
                                        </Flex>
                                      </Table.Cell>
                                    </Table.Row>
                                  ))}
                              </Table.Body>
                            </Table.Root>
                          </Flex>
                        ))}
                    </Flex>
                  </Box>

                  <Box display={{ initial: "none", lg: "block" }}>
                    <ImportErrorsTable rows={errorRows} />
                  </Box>
                </>
              ) : (
                <Callout.Root color="green" variant="soft">
                  <Callout.Icon>
                    <CheckCircle2 size={16} aria-hidden />
                  </Callout.Icon>
                  <Callout.Text>{t("screen.importReady")}</Callout.Text>
                </Callout.Root>
              )}

              <Button
                onClick={() => file && commit.execute(fileForm(file))}
                disabled={!canConfirm || commit.isPending}
              >
                {commit.isPending ? <Spinner /> : <Upload size={16} />}
                {t("screen.confirmImport")}
              </Button>
            </Flex>
          )}
        </Flex>
      </Card>
    </Flex>
  );
}
