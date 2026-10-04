"use client";

import { useRef } from "react";
import { chakra } from "@chakra-ui/react";
import { MOMENTS, moments } from "@narriflow/stage";
import { useStageCanvas } from "./stage/use-stage-canvas";

const Canvas = chakra("canvas");

/**
 * Live backdrop for the closing call to action: the moment-detection river
 * keeps flowing along the bottom of the band, fading out behind the copy.
 */
export function ClosingStage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useStageCanvas(
    canvasRef,
    (ctx, w, h, now) => {
      const k = Math.max(w / moments.width, (h * 0.9) / moments.height);
      ctx.save();
      // river centre sits at 80% of the band height
      ctx.translate((w - moments.width * k) / 2, h * 0.8 - MOMENTS.riverY * k);
      ctx.scale(k, k);
      moments.draw(ctx, now % moments.duration);
      ctx.restore();
      const veil = ctx.createLinearGradient(0, 0, 0, h);
      veil.addColorStop(0, "rgba(8,9,12,0.94)");
      veil.addColorStop(0.58, "rgba(8,9,12,0.86)");
      veil.addColorStop(0.8, "rgba(8,9,12,0.3)");
      veil.addColorStop(1, "rgba(8,9,12,0.6)");
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, w, h);
    },
    { stillAt: 1.9, maxPixels: 1_600_000 },
  );

  return <Canvas ref={canvasRef} position="absolute" inset="0" w="full" h="full" display="block" aria-hidden="true" />;
}
