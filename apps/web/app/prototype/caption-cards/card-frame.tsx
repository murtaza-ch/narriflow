"use client";

import { useEffect, useMemo, useState } from "react";
import { captionSceneDemo, captionSceneStillMs } from "@narriflow/caption-scene";
import { CAPTION_PRESETS, type CaptionFontName } from "@narriflow/validators";
import { CaptionPresetPreview } from "../../(app)/_shared/caption-preset-preview";
import { PRESET_CARD_FRAME } from "../../(app)/_shared/caption-card-frame";
import { CAPTION_SAMPLE_LOOP_SEC } from "../../(app)/_shared/caption-sample-cue";
import type { CaptionTimeSource } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";
import type { MeasuredScene } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-scene-painter";

/** What the recorder reads and drives. */
interface CardControl {
  readonly loopSec: number;
  readonly stillSec: number;
  readonly scene: boolean;
  faces: CaptionFontName[] | null;
  set(seconds: number): void;
}

declare global {
  interface Window {
    __card?: CardControl;
  }
}

function manualClock() {
  let now = 0;
  const listeners = new Set<() => void>();
  const source: CaptionTimeSource = {
    getSnapshot: () => now,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    set(seconds: number) {
      now = seconds;
      for (const listener of listeners) listener();
    },
  };
}

export function CardFrame({ presetId, width }: { presetId: string; width: number }) {
  const named = CAPTION_PRESETS.find((preset) => preset.id === presetId)!;
  const scene = named.preset.scene;
  const clock = useMemo(manualClock, []);
  const [control] = useState<CardControl>(() => ({
    loopSec: scene ? captionSceneDemo(scene).duration / 1000 : CAPTION_SAMPLE_LOOP_SEC,
    // The still the live card shows with reduced motion.
    stillSec: scene ? captionSceneStillMs(scene) / 1000 : CAPTION_SAMPLE_LOOP_SEC - 0.1,
    scene: scene !== undefined,
    faces: null,
    set: clock.set,
  }));

  useEffect(() => {
    window.__card = control;
    return () => {
      delete window.__card;
    };
  }, [control]);

  const onSceneBuilt = useMemo(
    () => (built: MeasuredScene) => {
      control.faces = [...new Set(built.scene.pieces.flatMap((piece) => (piece.kind === "text" ? [piece.face] : [])))].sort();
    },
    [control],
  );

  return (
    <div style={{ padding: 0, margin: 0, background: "#000" }}>
      <div data-card-frame style={{ width }}>
        <CaptionPresetPreview
          namedPreset={named}
          aspectRatio={PRESET_CARD_FRAME.aspectRatio}
          backdropFocusYPct={PRESET_CARD_FRAME.backdropFocusYPct}
          captionTopPct={PRESET_CARD_FRAME.captionTopPct}
          boost={PRESET_CARD_FRAME.boost}
          imageSizes={`${width * 2}px`}
          timeSource={clock.source}
          onSceneBuilt={onSceneBuilt}
        />
      </div>
    </div>
  );
}
