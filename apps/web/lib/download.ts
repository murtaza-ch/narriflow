/** How long a saved Blob's object URL stays valid; the browser may start the save after the click returns. */
export const OBJECT_URL_LIFETIME_MS = 60_000;

/** Starts a browser download of `url` through a temporary anchor. */
export function downloadUrl(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Saves a fetched file. The object URL outlives the click, so the save is never cut short. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, fileName);
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}
