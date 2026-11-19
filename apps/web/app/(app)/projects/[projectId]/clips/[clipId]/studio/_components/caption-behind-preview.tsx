"use client";

import { type CSSProperties, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type CaptionBehindPlacement,
  captionBehindColumns,
  captionBehindPlacement,
  captionMatteColumnTop,
} from "@narriflow/caption-fonts/caption-block";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import type { CaptionBlockPaint } from "./caption-block-painter";
import { canvasMatteFromRegionMask, type MatteRect, type RegionMatte, videoRegion } from "./person-matte-geometry";

// Heroes behind the speaker in the Studio preview (dynamic captions spec 5.12). A module Web Worker
// segments preview frames (at most 15 a second, only while a behind hero is on screen, loaded the
// first time one is); the person canvas redraws the current video frame masked by the latest result
// on every presented frame, with the main video's own CSS geometry; each cue is placed once by the
// shared rule from this matte. Preview and export may place a cue a few px apart (each reads its
// own matte): the recorded parity exception for behind cues.

export const PERSON_MATTE_MODEL_URL = "/models/selfie_segmenter.tflite";
/** At most this many segmenter frames a second. */
const SEGMENT_INTERVAL_MS = 1000 / 15;
const SEGMENTER_SIDE = 256;

export type PersonMatteStatus = "idle" | "loading" | "ready" | "failed";

// One segmenter for the whole Studio, and its status for the Captions panel's notice.
let status: PersonMatteStatus = "idle";
const statusListeners = new Set<() => void>();
let ready: Promise<Worker> | null = null;

function setStatus(next: PersonMatteStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}

/** The Studio segmenter's status: "failed" draws behind heroes in front and shows the panel notice. */
export function usePersonMatteStatus(): PersonMatteStatus {
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    () => status,
    () => "idle",
  );
}

function startSegmenter(): Promise<Worker> {
  if (ready) return ready;
  setStatus("loading");
  ready = new Promise<Worker>((resolve, reject) => {
    try {
      const created = new Worker(new URL("./person-matte.worker.ts", import.meta.url), { type: "module" });
      const onMessage = (event: MessageEvent<{ type: string; message?: string }>) => {
        if (event.data.type === "ready") {
          created.removeEventListener("message", onMessage);
          setStatus("ready");
          resolve(created);
        } else if (event.data.type === "error") {
          created.removeEventListener("message", onMessage);
          created.terminate();
          reject(new Error(event.data.message ?? "person matte unavailable"));
        }
      };
      created.addEventListener("message", onMessage);
      created.addEventListener("error", (event) => reject(new Error(event.message || "person matte worker failed")));
      created.postMessage({ type: "init", modelUrl: new URL(PERSON_MATTE_MODEL_URL, window.location.href).href });
    } catch (error) {
      reject(error);
    }
  });
  ready.catch((error: unknown) => {
    console.warn(JSON.stringify({ level: "warn", message: "caption_matte_unavailable", detail: error instanceof Error ? error.message : String(error) }));
    setStatus("failed");
  });
  return ready;
}

/** Where the main source layer draws now: what the segmenter reads and how the person canvas is laid out. */
export interface CaptionPersonSource {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** The plan's source size (source px), which crops are in. */
  readonly sourceSize: { readonly width: number; readonly height: number };
  /** The main source layer's crop at this moment (crop track applied) and its canvas destination. */
  readonly crop: MatteRect;
  readonly destination: MatteRect;
  /** The main video's frame, mask and element styles, so the person canvas lands exactly on it. */
  readonly frameStyle: CSSProperties;
  readonly maskStyle: CSSProperties;
  readonly videoStyle: CSSProperties;
  /** B-roll or an inserted scene covers the speaker: the render's matte is zero there, so no person is drawn. */
  readonly covered: boolean;
}

/** The latest matte and who wants to hear about the next one. */
export interface PersonMatteFeed {
  readonly latest: RefObject<RegionMatte | null>;
  subscribe(listener: () => void): () => void;
}

/**
 * Feeds preview frames of the main video to the segmenter while `active`: through
 * `requestVideoFrameCallback`, at most 15 a second, one in flight, the crop only, stretched to
 * 256x256 (as MediaPipe and the render do).
 */
export function usePersonMatte(source: CaptionPersonSource | null, active: boolean): PersonMatteFeed {
  const latest = useRef<RegionMatte | null>(null);
  const listeners = useRef(new Set<() => void>());
  const [feed] = useState<PersonMatteFeed>(() => ({
    latest,
    subscribe(listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }));
  const regionRef = useRef<{ crop: MatteRect; sourceSize: { width: number; height: number } } | null>(null);
  regionRef.current = source ? { crop: source.crop, sourceSize: source.sourceSize } : null;
  const video = source?.videoRef.current ?? null;
  const enabled = active && video !== null && source?.covered !== true;

  useEffect(() => {
    if (!enabled || !video) return;
    let live = true;
    let frameHandle = 0;
    let inFlight = false;
    let lastSentMs = -Infinity;
    let nextId = 0;
    let target: Worker | null = null;
    const pending = new Map<number, MatteRect>();
    const onMessage = (event: MessageEvent<{ type: string; id?: number; width?: number; height?: number; data?: Uint8ClampedArray }>) => {
      const message = event.data;
      if (message.id === undefined || !pending.has(message.id)) return;
      const region = pending.get(message.id)!;
      pending.delete(message.id);
      inFlight = false;
      if (message.type !== "mask" || !message.data || !message.width || !message.height) return;
      latest.current = { width: message.width, height: message.height, data: message.data, region };
      for (const listener of listeners.current) listener();
    };
    const send = async () => {
      const current = regionRef.current;
      if (!target || inFlight || !current || video.videoWidth === 0) return;
      const now = performance.now();
      if (now - lastSentMs < SEGMENT_INTERVAL_MS) return;
      lastSentMs = now;
      inFlight = true;
      const region = current.crop;
      const pixels = videoRegion(region, current.sourceSize, { width: video.videoWidth, height: video.videoHeight });
      try {
        const bitmap = await createImageBitmap(video, pixels.x, pixels.y, pixels.width, pixels.height, {
          resizeWidth: SEGMENTER_SIDE, resizeHeight: SEGMENTER_SIDE, resizeQuality: "medium",
        });
        if (!live) {
          bitmap.close();
          return;
        }
        const id = nextId++;
        pending.set(id, region);
        target.postMessage({ type: "frame", id, bitmap }, [bitmap]);
      } catch {
        inFlight = false;
      }
    };
    const onFrame = () => {
      if (!live) return;
      void send();
      frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    void startSegmenter().then((started) => {
      if (!live) return;
      target = started;
      started.addEventListener("message", onMessage);
      void send();
      frameHandle = video.requestVideoFrameCallback(onFrame);
    }, () => undefined);
    return () => {
      live = false;
      if (frameHandle) video.cancelVideoFrameCallback(frameHandle);
      target?.removeEventListener("message", onMessage);
    };
  }, [enabled, video]);
  return feed;
}

/** Placements decided this session, by cue and unlifted layout, so seeking back keeps a cue's place. */
const placements = new Map<string, CaptionBehindPlacement>();

/**
 * Decides a behind cue's placement once, by the shared rule, from the first matte that arrives while
 * the hero is on screen. Null until then: the hero is drawn in front meanwhile. When the speaker is
 * covered there is no person, so the hero stays behind, unmoved; a failed segmenter draws it in front.
 */
export function useBehindPlacement(input: {
  layer: CompositionCaptionVisualLayer;
  paint: CaptionBlockPaint | null;
  source: CaptionPersonSource | null;
  feed: PersonMatteFeed;
  matteStatus: PersonMatteStatus;
  timeSec: number;
}): CaptionBehindPlacement | null {
  const { layer, paint, source, feed, matteStatus, timeSec } = input;
  const heroInk = paint?.layout.heroInk ?? null;
  const key = paint && heroInk ? `${layer.id}|${paint.layout.bounds.y.toFixed(2)}|${heroInk.y.toFixed(2)}|${heroInk.width.toFixed(2)}` : null;
  const [, setDecided] = useState(0);
  const heroIndex = layer.block?.roles.indexOf("hero") ?? -1;
  const onsetSec = heroIndex >= 0 ? layer.words[heroIndex]!.startSec : Infinity;
  const heroVisible = timeSec >= onsetSec && timeSec <= layer.activeRange.endSec;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    if (!key || !heroInk || !paint || placements.has(key) || !heroVisible) return;
    if (sourceRef.current?.covered) {
      placements.set(key, { behind: true, liftPx: 0 });
      setDecided((count) => count + 1);
      return;
    }
    const decide = () => {
      const matte = feed.latest.current;
      const current = sourceRef.current;
      if (!matte || !current || placements.has(key)) return;
      const canvas = { width: layer.destination.width, height: layer.destination.height };
      const canvasMatte = canvasMatteFromRegionMask({ matte, crop: current.crop, destination: current.destination, canvas });
      const personTop = captionBehindColumns(heroInk).map((x) => captionMatteColumnTop(canvasMatte, canvas, x));
      placements.set(key, captionBehindPlacement({ heroInk, bounds: paint.layout.bounds, canvas, personTop }));
      setDecided((count) => count + 1);
    };
    return feed.subscribe(decide);
  }, [key, heroInk, paint, heroVisible, feed, layer.destination.width, layer.destination.height]);

  if (matteStatus === "failed" || !key) return null;
  return placements.get(key) ?? null;
}

/**
 * The person over the behind hero: the current video frame masked by the latest matte
 * (`destination-in`), with the main video's frame, mask and element styles, repainted on every
 * presented frame. `origin` is the container's top-left in the parent's coordinates (display px).
 */
export function PersonMatteLayer({ source, feed, containerSize, origin }: {
  source: CaptionPersonSource;
  feed: PersonMatteFeed;
  containerSize: { readonly width: number; readonly height: number };
  origin: { readonly x: number; readonly y: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const video = source.videoRef.current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !video) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = SEGMENTER_SIDE;
    maskCanvas.height = SEGMENTER_SIDE;
    const maskContext = maskCanvas.getContext("2d");
    let maskRegion: MatteRect | null = null;
    let shownMatte: RegionMatte | null = null;
    let live = true;
    let handle = 0;
    const loadMask = () => {
      const matte = feed.latest.current;
      if (!matte || matte === shownMatte || !maskContext) return;
      shownMatte = matte;
      if (maskCanvas.width !== matte.width || maskCanvas.height !== matte.height) {
        maskCanvas.width = matte.width;
        maskCanvas.height = matte.height;
      }
      const image = maskContext.createImageData(matte.width, matte.height);
      for (let index = 0; index < matte.width * matte.height; index++) image.data[index * 4 + 3] = matte.data[index]!;
      maskContext.putImageData(image, 0, 0);
      maskRegion = matte.region;
    };
    const paint = () => {
      loadMask();
      if (!maskRegion || video.videoWidth === 0) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const region = videoRegion(maskRegion, sourceRef.current.sourceSize, { width: video.videoWidth, height: video.videoHeight });
      context.globalCompositeOperation = "copy";
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "destination-in";
      context.drawImage(maskCanvas, region.x, region.y, region.width, region.height);
      context.globalCompositeOperation = "source-over";
    };
    const onFrame = () => {
      if (!live) return;
      paint();
      handle = video.requestVideoFrameCallback(onFrame);
    };
    paint();
    handle = video.requestVideoFrameCallback(onFrame);
    // A paused video presents no frames: repaint when a new matte arrives or the user seeks.
    const unsubscribe = feed.subscribe(paint);
    video.addEventListener("seeked", paint);
    return () => {
      live = false;
      video.cancelVideoFrameCallback(handle);
      unsubscribe();
      video.removeEventListener("seeked", paint);
    };
  }, [video, feed]);

  return (
    <div
      aria-hidden
      style={{ position: "absolute", left: `${origin.x}px`, top: `${origin.y}px`, width: `${containerSize.width}px`, height: `${containerSize.height}px`, pointerEvents: "none" }}
    >
      <div style={{ position: "absolute", ...source.frameStyle }}>
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", ...source.maskStyle }}>
          <canvas ref={canvasRef} style={{ ...source.videoStyle, display: "block" }} />
        </div>
      </div>
    </div>
  );
}
