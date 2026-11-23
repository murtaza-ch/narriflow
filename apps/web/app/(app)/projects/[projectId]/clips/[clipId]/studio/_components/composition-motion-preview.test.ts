import { describe, expect, test } from "bun:test";
import { planTransitionMotion } from "@narriflow/composition-plan";
import type { StudioTransition } from "@narriflow/validators";
import { createClipTransitionPreview } from "./composition-motion-preview";

function harness(options: {
  playing?: boolean;
  rate?: number;
  application?: "source" | "overlay";
  type?: StudioTransition["type"];
} = {}) {
  let time = 0;
  const listeners = new Set<() => void>();
  const animation = {
    currentTime: 0 as number | null,
    playbackRate: 1,
    playState: "running",
    plays: 0,
    cancelled: false,
    play() { this.playState = "running"; this.plays++; },
    pause() { this.playState = "paused"; },
    cancel() { this.cancelled = true; },
  };
  let frames: Keyframe[] = [];
  const element = {
    animate(keyframes: Keyframe[]) { frames = keyframes; return animation; },
  } as unknown as HTMLElement;
  const motion = planTransitionMotion({
    type: options.type ?? "slide-left", durationSec: 1.5,
    activeRange: { startSec: 0, endSec: 6 }, canvas: { width: 1080, height: 1920 },
  });
  const preview = createClipTransitionPreview({
    element, motion, canvas: { width: 1080, height: 1920 }, application: options.application ?? "source",
    clock: {
      getSnapshot: () => time, getServerSnapshot: () => 0,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    playing: options.playing ?? true, rate: options.rate ?? 1,
  });
  return {
    animation, preview, frames,
    tick(next: number) { time = next; for (const listener of listeners) listener(); },
    subscribers: () => listeners.size,
  };
}

describe("clip transition preview", () => {
  test("runs between media frames without resetting the compositor's clock every frame", () => {
    const h = harness();
    expect(h.animation.playState).toBe("running");
    expect(h.frames.map((frame) => frame.offset)).toEqual([0, 0.25, 0.75, 1]);
    expect(h.frames[0]?.transform).toBe("translate(100.000%, 0.000%) scale(1.000000)");
    // The compositor has advanced past the last 30fps video observation.
    h.animation.currentTime = 48;
    h.tick(1 / 30);
    expect(h.animation.currentTime).toBe(48);
    expect(h.animation.plays).toBe(1);
    h.preview.dispose();
  });

  test("corrects a seek, holds the end, and releases animation and clock subscriptions", () => {
    const h = harness();
    h.tick(5.5);
    expect(h.animation.currentTime).toBe(5500);
    h.tick(6);
    expect(h.animation.playState).toBe("paused");
    expect(h.animation.currentTime).toBe(6000);
    expect(h.animation.plays).toBe(1);
    h.preview.dispose();
    expect(h.animation.cancelled).toBe(true);
    expect(h.subscribers()).toBe(0);
  });

  test("paused or buffering playback stays on the exact observed frame", () => {
    const h = harness({ playing: false });
    expect(h.animation.playState).toBe("paused");
    h.tick(0.25);
    expect(h.animation.currentTime).toBe(250);
    h.tick(5.9);
    expect(h.animation.currentTime).toBe(5900);
    expect(h.animation.plays).toBe(0);
    h.preview.dispose();
  });

  test("uses the selected playback rate and animates fades without geometry", () => {
    const h = harness({ rate: 1.5, type: "fade", application: "overlay" });
    expect(h.animation.playbackRate).toBe(1.5);
    expect(h.frames).toEqual([
      { offset: 0, opacity: 1 },
      { offset: 0.25, opacity: 0 },
      { offset: 0.75, opacity: 0 },
      { offset: 1, opacity: 1 },
    ]);
    h.preview.dispose();
  });
});
