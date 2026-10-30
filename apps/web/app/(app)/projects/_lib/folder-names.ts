/** The message shown under the name field when a folder already has that name. */
export const FOLDER_NAME_TAKEN_MESSAGE = "A folder with this name already exists.";

/** Mirrors the server's matching (case, spacing and Unicode forms are ignored); the server stays authoritative. */
function folderKey(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** True when another folder already carries this name. `exceptId` is the folder being renamed. */
export function isFolderNameTaken(
  name: string,
  folders: ReadonlyArray<{ id: string; name: string }>,
  exceptId?: string,
) {
  const key = folderKey(name);
  if (!key) return false;
  return folders.some((folder) => folder.id !== exceptId && folderKey(folder.name) === key);
}
