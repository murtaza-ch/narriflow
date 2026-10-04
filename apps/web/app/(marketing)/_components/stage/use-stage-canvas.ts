"use client";

import { type RefObject, useEffect, useRef } from "react";
import { configureFonts } from "@narriflow/stage";

let fontsReady: Promise<void> | null = null;

/**
 * Point the stage at the families next/font registered (see app/layout.tsx)
 * and load the faces it draws with. Canvas text never triggers a font load
 * on its own, so this has to happen before the first paint.
 */
export function ensureStageFonts() {
  if (fontsReady) return fontsReady;
  const css = getComputedStyle(document.documentElement);
  const family = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const display = family("--font-display", "sans-serif");
  const mono = family("--font-geist-mono", "monospace");
  const captions = {
    "Bebas Neue": family("--font-caption-bebas-neue", "sans-serif"),
    Anton: family("--font-caption-anton", "sans-serif"),
    Montserrat: family("--font-caption-montserrat", "sans-serif"),
    Oswald: family("--font-caption-oswald", "sans-serif"),
    Roboto: family("--font-caption-roboto", "sans-serif"),
    "Open Sans": family("--font-caption-open-sans", "sans-serif"),
  };
  configureFonts({ display, mono, captions });
  const faces = [
    `500 20px ${display}`,
    `700 20px ${display}`,
    `500 20px ${mono}`,
    `600 20px ${mono}`,
    `400 20px ${captions["Bebas Neue"]}`,
    `400 20px ${captions.Anton}`,
    `700 20px ${captions.Montserrat}`,
    `400 20px ${captions.Montserrat}`,
    `700 20px ${captions.Oswald}`,
    `700 20px ${captions.Roboto}`,
    `700 20px ${captions["Open Sans"]}`,
  ];
  fontsReady = Promise.all(faces.map((face) => document.fonts.load(face))).then(
    () => undefined,
    () => undefined,
  );
  return fontsReady;
}

export type Paint = (ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number) => void;

/**
 * Keep a canvas sized to its box and repaint it every frame while it is on
 * screen. `paint` gets CSS-pixel dimensions and a running clock in seconds.
 * With reduced motion the clock stops at `stillAt` and repaints only on
 * resize, a new paint callback, or when `invalidate()` is called.
 */
export function useStageCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  paint: Paint,
  { stillAt = 0, maxPixels = 2_600_000 }: { stillAt?: number; maxPixels?: number } = {},
) {
  const paintRef = useRef(paint);
  const dirty = useRef(true);

  useEffect(() => {
    paintRef.current = paint;
    dirty.current = true;
  }, [paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let visible = false;
    let ready = false;
    let frame = 0;
    const start = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min(dpr, Math.sqrt(maxPixels / Math.max(1, width * height)));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      dirty.current = true;
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!ready || !visible || width === 0) return;
      if (reduced && !dirty.current) return;
      dirty.current = false;
      const seconds = reduced ? stillAt : (performance.now() - start) / 1000;
      ctx.save();
      paintRef.current(ctx, width, height, seconds);
      ctx.restore();
    };

    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(canvas);
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      dirty.current = true;
    });
    viewObserver.observe(canvas);
    resize();
    ensureStageFonts().then(() => {
      ready = true;
      dirty.current = true;
    });
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
    };
  }, [canvasRef, stillAt, maxPixels]);

  return {
    invalidate: () => {
      dirty.current = true;
    },
  };
}
