import { describe, expect, test } from "bun:test";
import {
  adoptResolvedAudioAssets,
  reconcileSelectedAudioAssets,
} from "./preview-audio-asset-resolution";

describe("preview audio asset resolution", () => {
  test("adopts a retained deferred SFX arrival after another asset is selected", () => {
    let resolutions = reconcileSelectedAudioAssets({}, ["a"]);
    resolutions = reconcileSelectedAudioAssets(resolutions, ["a", "b"]);
    resolutions = adoptResolvedAudioAssets(resolutions, [
      ["a", { state: "available", url: "https://example.com/a.wav", durationSec: 1 }],
    ]);

    expect(resolutions).toEqual({
      a: {
        state: "available",
        url: "https://example.com/a.wav",
        durationSec: 1,
      },
      b: { state: "pending" },
    });
  });

  test("ignores a deferred arrival after its asset is removed", () => {
    let resolutions = reconcileSelectedAudioAssets({}, ["a"]);
    resolutions = reconcileSelectedAudioAssets(resolutions, ["b"]);
    const afterLateArrival = adoptResolvedAudioAssets(resolutions, [
      ["a", { state: "available", url: "https://example.com/a.wav", durationSec: 1 }],
    ]);

    expect(afterLateArrival).toBe(resolutions);
    expect(afterLateArrival).toEqual({ b: { state: "pending" } });
  });
});
