import { detectLinkProvider } from "@narriflow/validators";
import { loadScript } from "./source-pickers";

const DROPBOX_SCRIPT = "https://www.dropbox.com/static/api/2/dropins.js";

interface DropboxChooserFile {
  link?: unknown;
}

export interface DropboxChooserApi {
  choose(options: {
    linkType: "preview";
    multiselect: false;
    extensions: string[];
    success(files: DropboxChooserFile[]): void;
    cancel(): void;
  }): void;
}

/** A Chooser result is usable only as a dropbox.com link the link intake can fetch. */
export function dropboxLinkFromChoice(
  files: readonly DropboxChooserFile[],
): string | null {
  const link = files[0]?.link;
  return typeof link === "string" && detectLinkProvider(link) === "dropbox"
    ? link
    : null;
}

export async function loadDropbox(appKey: string): Promise<DropboxChooserApi> {
  await loadScript(DROPBOX_SCRIPT, { id: "dropboxjs", "data-app-key": appKey });
  const dropbox = (window as unknown as { Dropbox?: DropboxChooserApi }).Dropbox;
  if (!dropbox) throw new Error("Dropbox did not load");
  return dropbox;
}

/** Opens the Dropbox Chooser for one video. Resolves the shared link, or null
 *  when the person closes the dialog. Call it straight from the click with the
 *  Chooser already loaded, so the browser doesn't block its popup. */
export function chooseDropboxVideo(
  dropbox: DropboxChooserApi,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    dropbox.choose({
      linkType: "preview",
      multiselect: false,
      extensions: ["video"],
      success: (files) => {
        const link = dropboxLinkFromChoice(files);
        if (link) resolve(link);
        else reject(new Error("Dropbox did not return a shared link"));
      },
      cancel: () => resolve(null),
    });
  });
}
