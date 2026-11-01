// A Claude Code project folder is its path with every separator turned into a dash
// («-home-me-projects-shelf», «C--Users-me-repos-shelf»). The path cannot be told back from the dashes, so the
// name is what follows the folder people keep their projects in, else what follows the home folder and its own
// folders (Documents, Desktop…), else the folder as written without its leading separators.
const KEPT_IN = /-(?:projects|repos|code|src|dev|work)-(.+)$/i;
const HOME = /^[A-Za-z]?-*(?:Users|home)-[^-]+-(.+)$/;
const PLAIN = "Documents|Documentos|Desktop|Escritorio|Downloads|Descargas";
// OneDrive, with an organisation word between it and a known folder («OneDrive-Acme-Documents»); never any other word.
const USER_FOLDER = new RegExp(`^(?:${PLAIN}|OneDrive(?:-[^-]+(?=-(?:${PLAIN})-))?(?:-(?:${PLAIN}))?)-(.+)$`, "i");

export function projectName(folder: string): string {
  const kept = KEPT_IN.exec(folder)?.[1];
  if (kept !== undefined) return kept;
  const home = HOME.exec(folder)?.[1];
  if (home !== undefined) return USER_FOLDER.exec(home)?.[1] ?? home;
  return folder.replace(/^[A-Za-z]?-+/, "") || folder;
}
