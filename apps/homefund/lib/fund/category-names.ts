export type CategoryScopeValue = "personal" | "group";

// Structural, so this file imports nothing from the server-only db layer.
export type NamedCategoryNode = {
  id: string;
  name: string;
  scope: CategoryScopeValue;
  children: readonly { id: string; name: string }[];
};

export type ScopeMark = (name: string) => string;

export function scopedCategoryName(
  name: string,
  scope: CategoryScopeValue,
  mark: ScopeMark,
): string {
  return scope === "group" ? mark(name) : name;
}

// The name apart from what the mark adds after it, so a screen can truncate the
// name and keep the mark whole. A mark that is not a suffix leaves the whole
// marked string as the name.
export function scopedCategoryParts(
  name: string,
  scope: CategoryScopeValue,
  mark: ScopeMark,
): { name: string; suffix: string | null } {
  if (scope !== "group") return { name, suffix: null };
  const marked = mark(name);
  return marked.startsWith(name)
    ? { name, suffix: marked.slice(name.length) }
    : { name: marked, suffix: null };
}

// Insertion order is the input's, each parent before its children.
export function categoryNamesById(
  nodes: readonly NamedCategoryNode[],
  mark: ScopeMark,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const node of nodes) {
    names.set(node.id, scopedCategoryName(node.name, node.scope, mark));
    for (const child of node.children) {
      names.set(child.id, scopedCategoryName(child.name, node.scope, mark));
    }
  }
  return names;
}
