import "server-only";

import { listAccounts } from "@/db/queries/accounts";
import { listScopedCategories } from "@/db/queries/categories";
import { codeOf, debtLikeName, type McpWarning, type Probe } from "@/lib/mcp/debt-words";

type Say = (key: string) => string;

// «Padre › Hijo» for every category the person reads, so a subcategory of «Deudas» reads as debt too.
async function categoryLabels(owner: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const parent of await listScopedCategories(owner)) {
    labels.set(parent.id, parent.name);
    for (const child of parent.children) labels.set(child.id, `${parent.name} ${child.name}`);
  }
  return labels;
}

/**
 * The warnings a write earns: an expense that reads as a debt payment, a loan or a saving, or an income that
 * reads as a disbursement or a collection, is a transfer in the model (RF-241). Reads nothing unless a probe
 * names a category, and the accounts only when one matched.
 */
export async function movementWarnings(owner: string, probes: Probe[], t: Say): Promise<McpWarning[]> {
  const labels = probes.some((probe) => probe.categoryIds.length > 0) ? await categoryLabels(owner) : new Map<string, string>();
  const hits = probes.flatMap((probe) => {
    const code = codeOf(probe, labels);
    return code === null ? [] : [{ code, probe }];
  });
  if (hits.length === 0) return [];
  const liabilities = (await listAccounts({ archived: false }))
    .filter((account) => account.kind === "liability" && account.canWrite)
    .map((account) => ({ id: account.id, name: account.name, subtype: account.subtype }));
  return [...new Set(hits.map((hit) => hit.code))].map((code) => {
    const mine = hits.filter((hit) => hit.code === code).map((hit) => hit.probe);
    const lines = mine.flatMap((probe) => (probe.line === undefined ? [] : [probe.line]));
    const deliveryIds = mine.flatMap((probe) => (probe.deliveryId === undefined ? [] : [probe.deliveryId]));
    return {
      code,
      message: t(`warnings.${code}${code === "debtAsExpense" && liabilities.length === 0 ? "NoLiability" : ""}`),
      ...(code === "savingsAsExpense" || liabilities.length === 0 ? {} : { liabilities }),
      ...(lines.length > 0 ? { lines } : {}),
      ...(deliveryIds.length > 0 ? { deliveryIds } : {}),
    };
  });
}

export type { McpWarning, Probe };

/** The warning a new category earns when its name says a debt or a saving, which are accounts, not categories. */
export function categoryNameWarnings(name: string, t: Say): McpWarning[] {
  return debtLikeName(name) ? [{ code: "debtLikeCategory", message: t("warnings.debtLikeCategory") }] : [];
}

/** The answer of a write, with its warnings when it earned any. */
export function withWarnings<T extends object>(result: T, warnings: McpWarning[]): T | (T & { warnings: McpWarning[] }) {
  return warnings.length === 0 ? result : { ...result, warnings };
}
