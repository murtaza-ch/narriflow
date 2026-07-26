import { describe, expect, test } from "bun:test";
import { brollUrlChanged } from "./clip.service";

describe("brollUrlChanged (updateClipBroll no-op guard)", () => {
  test("returns false when both sides are null (no B-roll selected, still none)", () => {
    expect(brollUrlChanged(null, null)).toBe(false);
  });

  test("returns false when re-saving the exact same URL", () => {
    const url = "https://videos.pexels.com/video-files/123/123.mp4";
    expect(brollUrlChanged(url, url)).toBe(false);
  });

  test("returns true when picking B-roll for the first time", () => {
    expect(
      brollUrlChanged(null, "https://videos.pexels.com/video-files/123/123.mp4"),
    ).toBe(true);
  });

  test("returns true when clearing a previously-chosen B-roll", () => {
    expect(
      brollUrlChanged("https://videos.pexels.com/video-files/123/123.mp4", null),
    ).toBe(true);
  });

  test("returns true when switching to a different B-roll clip", () => {
    expect(
      brollUrlChanged(
        "https://videos.pexels.com/video-files/123/123.mp4",
        "https://videos.pexels.com/video-files/456/456.mp4",
      ),
    ).toBe(true);
  });
});
