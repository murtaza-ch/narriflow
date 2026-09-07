import { expect, test } from "bun:test";
import { attachLocalMediaPreview } from "./local-media-preview";

test("the preview remains readable after React replays setup and cleanup", async () => {
  const file = new File(["test video bytes"], "source.mp4", {
    type: "video/mp4",
  });
  const media = {
    src: "",
    load() {},
    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    },
  };
  const firstCleanup = attachLocalMediaPreview(media, file);
  const firstUrl = media.src;
  expect(await (await fetch(firstUrl)).text()).toBe("test video bytes");
  firstCleanup();
  const secondCleanup = attachLocalMediaPreview(media, file);
  expect(media.src).not.toBe(firstUrl);
  expect(await (await fetch(media.src)).text()).toBe("test video bytes");
  const activeUrl = media.src;
  secondCleanup();
  expect(media.src).toBe("");
  await expect(fetch(activeUrl)).rejects.toThrow();
});
