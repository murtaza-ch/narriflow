"use client";

/**
 * A Text Layer style drawn by the real painter in a small frame: the Presets tab's cards and the
 * brand kit's live sample. The sample's size is scaled up from the style (size, stroke, shadow
 * together) so a card reads at thumbnail size; everything else is the style as it is.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import type { StudioTextLayer, TextLayerStyle } from "@narriflow/validators";
import { staticTimeSource } from "./caption-block-painter";
import { CaptionSceneLayers } from "./caption-scene-painter";
import { useTextLayerScene } from "./text-layer-scene";

const SAMPLE_CANVAS = { width: 1080, height: 640 } as const;
const SAMPLE_WINDOW = { fromMs: 0, toMs: 1_000_000 } as const;
const SAMPLE_FONT_SIZE = 180;
const still = staticTimeSource(0);

/** The style at sample size: font size, stroke width and shadow scaled together. */
export function sampleStyle(style: TextLayerStyle, fontSize = SAMPLE_FONT_SIZE): TextLayerStyle {
  const k = fontSize / style.fontSize;
  return {
    ...style,
    fontSize,
    stroke: style.stroke ? { ...style.stroke, width: style.stroke.width * k } : null,
    shadow: style.shadow ? { ...style.shadow, blur: style.shadow.blur * k, offsetX: style.shadow.offsetX * k, offsetY: style.shadow.offsetY * k } : null,
  };
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function TextStyleSample({ style, text = "Your title\ngoes here", fontSize }: { style: TextLayerStyle; text?: string; fontSize?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const entries = useMemo(() => {
    // Not parsed: a sample's scaled stroke may pass the schema's range, and the layout does not need it to.
    const layer: StudioTextLayer = { id: "sample", role: "title", text, startSec: 0, endSec: null, positionX: 50, positionY: 50, widthPct: 100, style: sampleStyle(style, fontSize) };
    return [{ layer, window: SAMPLE_WINDOW }];
  }, [style, text, fontSize]);
  const built = useTextLayerScene(entries, SAMPLE_CANVAS);
  const scale = width / SAMPLE_CANVAS.width;
  return (
    <Box ref={ref} position="relative" w="full" aspectRatio={`${SAMPLE_CANVAS.width} / ${SAMPLE_CANVAS.height}`} overflow="hidden" aria-hidden>
      {built && width > 0 ? <CaptionSceneLayers built={built.built} canvas={SAMPLE_CANVAS} scale={scale} timeSource={still} /> : null}
    </Box>
  );
}
