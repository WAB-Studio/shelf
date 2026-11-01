import type { WindowTime } from "@/lib/queries";

export type ProjectTime = { project: string; seconds: number };

// Editors whose title reads «file — folder — [profile —] product»: VS Code, its Insiders and OSS builds, VSCodium, Cursor.
// Lower-cased process names without «.exe».
const EDITORS = new Set(["code", "code - insiders", "code-insiders", "code - oss", "code-oss", "codium", "vscodium", "cursor"]);
const SEPARATOR = /\s+[-–—]\s+/;
const PRODUCT = /\s+[-–—]\s+(?:Visual Studio Code(?:\s+[-–—]\s+Insiders)?|Code - OSS|VSCodium|Cursor)$/i;
// Any bracketed tag — «[WSL: Ubuntu]», «[SSH: host]», «[Tunnel: x]», «[Container …]», «[Administrator]» — and «(Workspace)»
// belongs to the window, not to the folder or the product.
const TAG = /\s*\[[^\]]*\]|\s*\(Workspace\)/g;
const FILE_NAME = /\.[A-Za-z0-9]{1,8}$/;
// Documents and data a window can hold alone; a dotted folder («next.js») is none of these.
const DOCUMENT = /\.(?:txt|md|markdown|json|jsonc|ya?ml|toml|csv|log|pdf|png|jpe?g|gif|svg|ini|lock|env)$/i;
const EXTENSIONLESS = /^(?:makefile|dockerfile|license|licence|readme|changelog|copying|authors|codeowners|gemfile|rakefile|procfile|jenkinsfile|vagrantfile|brewfile|untitled(?:-\d+)?)$/i;
// VS Code's own editors, which have a title but no folder.
const SCREENS = /^(?:welcome|settings|keyboard shortcuts|extensions|get started|walkthrough:.*|release notes:.*|extension:.*|interactive playground|editor playground|search|source control|run and debug|output)$/i;

const looksLikeFile = (part: string) => part.startsWith(".") || FILE_NAME.test(part) || EXTENSIONLESS.test(part);

// The workspace folder a VS Code-family window title names, or null: not an editor, no folder open, or a screen of the
// editor itself. The title is «file — folder — [profile —] product»: with three or more parts the folder follows the file;
// with two it is the first unless that reads as a file; a lone part is a folder unless it is a document or a known file.
export function projectOfWindow(app: string, title: string): string | null {
  if (!EDITORS.has(app.toLowerCase().replace(/\.exe$/, ""))) return null;
  const bare = title.replace(/^\[Extension Development Host\]\s*/, "").replace(TAG, "");
  const product = PRODUCT.exec(bare);
  if (product === null) return null;
  const parts = bare.slice(0, product.index).split(SEPARATOR).map((part) => part.replace(/^[●•]\s*/, "").trim());
  const [first = ""] = parts;
  let folder: string;
  if (parts.length === 1) folder = DOCUMENT.test(first) || (first.startsWith(".") || EXTENSIONLESS.test(first)) ? "" : first;
  else folder = parts.length === 2 && !looksLikeFile(first) ? first : (parts[1] ?? "");
  return folder === "" || SCREENS.test(folder) || EXTENSIONLESS.test(folder) ? null : folder;
}

// Seconds per project over a day's window rows, longest first.
export function projectsOf(windows: WindowTime[]): ProjectTime[] {
  const seconds = new Map<string, number>();
  for (const one of windows) {
    const project = projectOfWindow(one.app, one.title);
    if (project !== null) seconds.set(project, (seconds.get(project) ?? 0) + one.seconds);
  }
  return [...seconds].map(([project, total]) => ({ project, seconds: total })).sort((a, b) => b.seconds - a.seconds || a.project.localeCompare(b.project));
}
