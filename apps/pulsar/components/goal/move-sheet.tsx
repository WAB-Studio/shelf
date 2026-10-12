"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { moveGoal } from "@/app/actions/plan";
import { dayBefore } from "@/lib/day/weeks";
import { moveTargets, type PlacementRefusal } from "@/lib/goals/placement";
import { refusalKey, refusalName } from "@/lib/goals/refusal-key";
import { buildTree, type TreeNode } from "@/lib/goals/tree";
import { civilDateLabel } from "@/lib/zone";
import { Button, CheckRow, Sheet, SheetActions, Text } from "@/components/ui";
import { type MessageKey } from "@/i18n/translator";

export type MoveGoalActionProps = {
  goalId: string;
  name: string;
  // The person's whole tree, in plan order.
  tree: TreeNode[];
  today: string;
};

// A pick the person can see: the ones that break the shape of the tree (a cycle, a fourth level,
// a goal already closed) never show; an archived goal is not a place either.
const SHOWN: PlacementRefusal["code"][] = ["aboveClosed", "endPastAbove"];

/**
 * `JerarquiaMover` (RP-82, RP-79): «Mover bajo otra meta» opens one radio row per
 * destination. The refusal the server would give runs here first, per row, on the tree
 * the page loaded — same function, same words. The action is not drawn when the goal has
 * nowhere to go.
 */
export function MoveGoalAction({ goalId, name, tree: nodes, today }: MoveGoalActionProps) {
  const t = useTranslations();
  const router = useRouter();
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const goal = tree.byId.get(goalId);
  const parentId = goal?.parentId ?? null;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(parentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = useMemo(
    () =>
      moveTargets(tree, goalId, today).filter((target) => {
        const node = tree.byId.get(target.id)!;
        if (node.archivedAt !== null) return false;
        return target.refusal === null || SHOWN.includes(target.refusal.code);
      }),
    [tree, goalId, today],
  );
  if (!goal || (parentId === null && targets.length === 0)) return null;

  const changed = choice !== parentId;

  function refusalText(refusal: PlacementRefusal): string {
    const above = "above" in refusal ? refusal.above : null;
    return t(refusalKey(refusal.code), {
      name: refusalName(refusal) ?? "",
      date: above ? civilDateLabel(dayBefore(above.horizon)) : "",
    });
  }

  function openSheet() {
    setChoice(parentId);
    setError(null);
    setOpen(true);
  }

  async function handleMove() {
    if (pending || !changed) return;
    setPending(true);
    setError(null);

    const result = await moveGoal({ goalId, parentId: choice });
    setPending(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else {
      const values = "values" in result ? result.values : undefined;
      setError(
        t(result.error as MessageKey, {
          name: values?.name ?? "",
          date: values?.date ? civilDateLabel(values.date) : "",
        }),
      );
    }
  }

  return (
    <>
      <Button variant="outline" block onClick={openSheet}>
        {t("tree.goal.move")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen} label={name} title={t("tree.move.title")}>
        <div role="radiogroup" aria-label={t("tree.move.title")}>
          {parentId !== null ? (
            <CheckRow
              radio="destination"
              checked={choice === null}
              onCheckedChange={() => setChoice(null)}
              disabled={pending}
              name={t("tree.move.top")}
              meta={t("tree.move.topHint")}
            />
          ) : null}
          {targets.map((target) => {
            const node = tree.byId.get(target.id)!;
            return (
              <CheckRow
                key={target.id}
                radio="destination"
                depth={node.depth > 0 ? 1 : 0}
                checked={choice === target.id}
                onCheckedChange={() => setChoice(target.id)}
                disabled={pending || target.refusal !== null}
                name={node.name}
                meta={target.refusal ? undefined : t(node.depth === 0 ? "tree.move.underGeneral" : "tree.move.underBig")}
                reason={target.refusal ? refusalText(target.refusal) : undefined}
              />
            );
          })}
        </div>
        {error ? (
          <Text as="p" variant="sentence" tone="muted" role="alert">
            {error}
          </Text>
        ) : null}
        <SheetActions>
          <Button block onClick={handleMove} disabled={pending || !changed}>
            {t("tree.move.confirm")}
          </Button>
          <Button block variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            {t("tree.move.cancel")}
          </Button>
        </SheetActions>
      </Sheet>
    </>
  );
}
