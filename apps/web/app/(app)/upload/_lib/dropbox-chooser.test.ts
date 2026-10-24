import { describe, expect, test } from "bun:test";
import {
  chooseDropboxVideo,
  dropboxLinkFromChoice,
  type DropboxChooserApi,
} from "./dropbox-chooser";

const PREVIEW_LINK =
  "https://www.dropbox.com/scl/fi/abc123/Weekly-sync.mp4?rlkey=xyz&dl=0";

describe("dropboxLinkFromChoice", () => {
  test("accepts the dropbox.com shared link link intake already supports", () => {
    expect(dropboxLinkFromChoice([{ link: PREVIEW_LINK }])).toBe(PREVIEW_LINK);
  });

  test("rejects anything link intake would not fetch as Dropbox", () => {
    expect(dropboxLinkFromChoice([])).toBeNull();
    expect(dropboxLinkFromChoice([{}])).toBeNull();
    expect(dropboxLinkFromChoice([{ link: "https://example.com/video.mp4" }])).toBeNull();
    expect(dropboxLinkFromChoice([{ link: "file:///etc/passwd" }])).toBeNull();
  });
});

describe("chooseDropboxVideo", () => {
  function chooser(run: (options: Parameters<DropboxChooserApi["choose"]>[0]) => void) {
    const calls: Array<Parameters<DropboxChooserApi["choose"]>[0]> = [];
    const api: DropboxChooserApi = {
      choose: (options) => {
        calls.push(options);
        run(options);
      },
    };
    return { api, calls };
  }

  test("asks for one video as a preview link and resolves the link", async () => {
    const { api, calls } = chooser((options) => options.success([{ link: PREVIEW_LINK }]));
    expect(await chooseDropboxVideo(api)).toBe(PREVIEW_LINK);
    expect(calls[0]).toMatchObject({ linkType: "preview", multiselect: false, extensions: ["video"] });
  });

  test("closing the dialog resolves null", async () => {
    const { api } = chooser((options) => options.cancel());
    expect(await chooseDropboxVideo(api)).toBeNull();
  });

  test("a result that is not a Dropbox link rejects", async () => {
    const { api } = chooser((options) => options.success([{ link: "https://example.com/a.mp4" }]));
    await expect(chooseDropboxVideo(api)).rejects.toThrow();
  });
});
