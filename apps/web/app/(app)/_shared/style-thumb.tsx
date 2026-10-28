"use client";

import type { ReactNode } from "react";
import { CAPTION_POSITION_Y_DEFAULTS, type CaptionPreset } from "@narriflow/validators";
import { CaptionSamplePreview } from "./caption-preset-preview";
import { captionBackdropSrc, captionStyleBackdrop, type CaptionBackdrop } from "./caption-preset-backdrops";

/** A caption style playing over footage; `seed` varies the frame across a library. */
export function StyleThumb({
  preset,
  seed,
  aspectRatio = "9 / 16",
  boost = 1.3,
  imageSizes = "200px",
  backdrop,
  captionTopPct,
  children,
}: {
  preset: CaptionPreset;
  seed: string;
  aspectRatio?: string;
  boost?: number;
  imageSizes?: string;
  backdrop?: CaptionBackdrop;
  /** Overrides the style's own position, e.g. to center the cue in a landscape cover. */
  captionTopPct?: number;
  children?: ReactNode;
}) {
  return (
    <CaptionSamplePreview
      preset={preset}
      backdropSrc={captionBackdropSrc(backdrop ?? captionStyleBackdrop(preset, seed))}
      aspectRatio={aspectRatio}
      captionTopPct={captionTopPct ?? preset.positionY ?? CAPTION_POSITION_Y_DEFAULTS[preset.position]}
      boost={boost}
      imageSizes={imageSizes}
    >
      {children}
    </CaptionSamplePreview>
  );
}
