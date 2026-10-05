/*
 * Hero storyboard (15 s loop, 1920×1080): scan → pick → reframe → caption →
 * ship → collapse back to the first frame. Pure timing + layout; each
 * renderer only draws what heroState(t) describes.
 */
import { clamp, ease, lerp, mod, ramp, rand } from "./math";
import { focusX, SCRIPT_DURATION } from "./script";
import type { PresetId } from "./palette";

export const HERO = { id: "hero", width: 1920, height: 1080, fps: 30, duration: 15 } as const;

export type Rect = { x: number; y: number; w: number; h: number };
export const lerpRect = (a: Rect, b: Rect, p: number): Rect => ({
  x: lerp(a.x, b.x, p),
  y: lerp(a.y, b.y, p),
  w: lerp(a.w, b.w, p),
  h: lerp(a.h, b.h, p),
});

export const STEPS = [
  { label: "Scan", from: 0, to: 2.8 },
  { label: "Pick", from: 2.8, to: 4.2 },
  { label: "Reframe", from: 4.2, to: 5.2 },
  { label: "Caption", from: 5.2, to: 10.0 },
  { label: "Ship", from: 10.0, to: 13.6 },
] as const;

export const SOURCE_SECONDS = 47 * 60 + 12;
const BIG: Rect = { x: 352, y: 150, w: 1216, h: 684 };
const SMALL: Rect = { x: 96, y: 384, w: 540, h: 303.75 };
export const CLIP: Rect = { x: 960 - 243, y: 150, w: 486, h: 864 };
const CLIP_SHIP: Rect = { x: 960 - 218, y: 118, w: 436, h: 775 };
export const CHIP_Y = 928;
export const TIMELINE: Rect = { x: 200, y: 912, w: 1520, h: 84 };
export const BARS = 190;

export const PINS = [
  { p: 0.2, score: 74 },
  { p: 0.53, score: 92 },
  { p: 0.8, score: 87 },
] as const;
export const BEST_PIN = 1;

export const SIBLINGS: Array<{
  side: -1 | 1;
  score: number;
  preset: PresetId;
  focus: 0 | 1;
  stOffset: number;
  platform: string;
  when: string;
}> = [
  { side: -1, score: 87, preset: "boldPop", focus: 1, stOffset: 2.7, platform: "TikTok", when: "Tue 09:00" },
  { side: 1, score: 74, preset: "highlighter", focus: 0, stOffset: 5.0, platform: "Reels", when: "Wed 18:00" },
];
export const CENTER_SHIP = { platform: "YouTube Shorts", when: "Tue 12:30" };

/** Waveform bar height 0..1 — a talky noise floor with swells at the pins. */
export const barAmp = (i: number) => {
  const p = i / (BARS - 1);
  const swell = PINS.reduce((m, pin) => Math.max(m, Math.exp(-(((p - pin.p) / 0.022) ** 2))), 0);
  const talk = 0.18 + 0.32 * rand(i, 7) * (0.6 + 0.4 * Math.sin(i * 0.37));
  return clamp(talk + swell * (0.45 + 0.2 * rand(i, 9)), 0.06, 1);
};
/** How much a bar belongs to a detected moment (for heat colouring). */
export const barHeat = (i: number) => {
  const p = i / (BARS - 1);
  return PINS.reduce((m, pin) => Math.max(m, Math.exp(-(((p - pin.p) / 0.03) ** 2))), 0);
};

/** Script time seen in the footage; wraps in silence, so the loop is seamless. */
export const heroST = (t: number) => mod(t - 5.0, SCRIPT_DURATION);

export const CROP_H = 860;
export const cropFor = (fx: number, h = CROP_H, cy = 540) => ({ cx: fx, cy, w: (h * 9) / 16, h });
export const cropOnScreen = (src: Rect, crop: { cx: number; cy: number; w: number; h: number }): Rect => {
  const k = src.w / 1920;
  return { x: src.x + (crop.cx - crop.w / 2) * k, y: src.y + (crop.cy - crop.h / 2) * k, w: crop.w * k, h: crop.h * k };
};

const scanEase = ease.inOut;
const SCAN_FROM = 0.3;
const SCAN_TO = 2.6;
/** Time at which the scan head crosses timeline position p (inverse of the eased sweep). */
const passTime = (p: number) => {
  let lo = SCAN_FROM;
  let hi = SCAN_TO;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (ramp(mid, SCAN_FROM, SCAN_TO, scanEase) < p) lo = mid;
    else hi = mid;
  }
  return lo;
};
const PIN_TIMES = PINS.map((pin) => passTime(pin.p));

export function heroState(t: number) {
  const st = heroST(t);
  const fx = focusX(st);
  const crop = cropFor(fx);

  const toSmall = ramp(t, 4.2, 5.2, ease.inOut);
  const toBig = ramp(t, 13.6, 14.6, ease.inOut);
  const source = lerpRect(lerpRect(BIG, SMALL, toSmall), BIG, toBig);
  const sourceAlpha = Math.min(1, Math.max(1 - ramp(t, 9.8, 10.3), ramp(t, 13.3, 13.8)));

  const cropScreen = cropOnScreen(source, crop);
  const lift = ramp(t, 4.2, 5.2, ease.inOut);
  const land = ramp(t, 13.6, 14.6, ease.inOut);
  const clipVisible = t >= 4.2 && t < 14.6;
  const clip =
    t < 5.2
      ? lerpRect(cropScreen, CLIP, lift)
      : t < 13.6
        ? lerpRect(CLIP, CLIP_SHIP, ramp(t, 10.0, 10.7))
        : lerpRect(CLIP_SHIP, cropScreen, land);
  // Clip chrome (radius, shadow, badge) grows in as it detaches from the source.
  const clipChrome = Math.min(ramp(t, 4.5, 5.2), 1 - ramp(t, 13.6, 14.3));

  // The timeline is hidden from 4.8 s to 14 s; it resets to unscanned at 13.9 s.
  const scan = t < 3 ? ramp(t, SCAN_FROM, SCAN_TO, scanEase) : t < 13.9 ? 1 : 0;
  const scanHeadAlpha = Math.min(ramp(t, 0.05, 0.3), 1 - ramp(t, 2.6, 3.0));
  const timelineAlpha = Math.max(1 - ramp(t, 4.2, 4.8), ramp(t, 14.0, 14.6));
  const pins = PINS.map((pin, i) => ({
    ...pin,
    reveal: t < 13.9 ? ramp(t, PIN_TIMES[i]!, PIN_TIMES[i]! + 0.45, ease.outBack) : 0,
    count: Math.round(pin.score * ramp(t, PIN_TIMES[i]!, PIN_TIMES[i]! + 0.6, ease.out)),
    dim: i === BEST_PIN ? 0 : ramp(t, 2.9, 3.3),
    best: i === BEST_PIN ? ramp(t, 2.9, 3.3) : 0,
  }));
  const pulse = i01(t, 2.9, 4.4) * (0.5 + 0.5 * Math.sin((t - 2.9) * Math.PI * 4));

  const cropWindowAlpha = Math.min(ramp(t, 3.1, 3.5), 1 - ramp(t, 14.55, 14.95));
  const transcriptAlpha = Math.min(ramp(t, 5.0, 5.6), 1 - ramp(t, 9.8, 10.3));
  const captionAlpha = Math.min(ramp(t, 4.9, 5.3), 1 - ramp(t, 13.3, 13.6));
  const clipScore = Math.round(92 * ramp(t, 4.6, 5.4, ease.out));

  const siblingIn = ramp(t, 10.0, 10.8, ease.outBack);
  const siblingOut = ramp(t, 13.3, 13.8, ease.in);
  const sib = clamp(siblingIn - siblingOut, 0, 1.2);
  const siblings = SIBLINGS.map((s) => {
    const w = CLIP_SHIP.w * 0.86;
    const h = CLIP_SHIP.h * 0.86;
    const cx = lerp(960, 960 + s.side * 540, sib);
    const cy = CLIP_SHIP.y + CLIP_SHIP.h / 2 + 12;
    const scale = lerp(0.7, 1, clamp(sib));
    return {
      ...s,
      rect: { x: cx - (w * scale) / 2, y: cy - (h * scale) / 2, w: w * scale, h: h * scale },
      rot: s.side * 5 * clamp(sib),
      alpha: clamp(sib * 1.6),
      st: mod(st + s.stOffset, SCRIPT_DURATION),
      crop: s.focus === 0 ? cropFor(655, 700, 500) : cropFor(1280, 820, 540),
    };
  });
  const chips = [0, 1, 2].map((k) => ({
    show: Math.min(ramp(t, 10.9 + k * 0.25, 11.3 + k * 0.25, ease.outBack), 1 - ramp(t, 13.2, 13.5)),
    check: ramp(t, 11.7 + k * 0.3, 11.95 + k * 0.3, ease.outBack),
    ring: ramp(t, 11.75 + k * 0.3, 12.45 + k * 0.3, ease.out),
  }));

  // After Ship the collapse leads straight back into Scan.
  const step = t >= STEPS[STEPS.length - 1]!.to ? 0 : STEPS.findIndex((s) => t >= s.from && t < s.to);

  return {
    t,
    st,
    fx,
    crop,
    source,
    sourceAlpha,
    cropScreen,
    cropWindowAlpha,
    clip,
    clipVisible,
    clipChrome,
    clipScore,
    captionAlpha,
    scan,
    scanHeadAlpha,
    timelineAlpha,
    pins,
    pulse,
    transcriptAlpha,
    siblings,
    siblingAlpha: clamp(sib * 1.6),
    chips,
    step,
    stepperAlpha: 1,
    headTimecode: scan * SOURCE_SECONDS,
    sourceTimecode: t < 3 || t >= 13.9 ? scan * SOURCE_SECONDS : PINS[BEST_PIN].p * SOURCE_SECONDS + st,
    sparks: sparks(t),
    clipShine: ramp(t, 5.0, 5.9, ease.inOut),
    siblingShine: ramp(t, 10.5, 11.3, ease.inOut),
  };
}

export type Spark = { x: number; y: number; r: number; a: number; color: string };

/**
 * Sparks thrown off the scan head: a steady trickle plus a burst at each
 * detected moment (green at the best one). Deterministic in t.
 */
function sparks(t: number): Spark[] {
  const out: Spark[] = [];
  const cy = TIMELINE.y + TIMELINE.h / 2;
  const emit = (tb: number, seed: number, burst: boolean, color: string) => {
    const age = t - tb;
    const life = burst ? 0.9 : 0.6;
    if (age < 0 || age > life) return;
    const hx = TIMELINE.x + ramp(tb, SCAN_FROM, SCAN_TO, scanEase) * TIMELINE.w;
    const ang = burst ? rand(seed, 1) * Math.PI * 2 : Math.PI + (rand(seed, 1) - 0.5) * 1.6;
    const speed = burst ? 160 + rand(seed, 2) * 260 : 120 + rand(seed, 2) * 220;
    const x = hx + Math.cos(ang) * speed * age;
    const y = cy + (rand(seed, 3) - 0.5) * TIMELINE.h * 0.7 + Math.sin(ang) * speed * age + 260 * age * age;
    const k = 1 - age / life;
    out.push({ x, y, r: (burst ? 3.2 : 2.4) * (0.6 + rand(seed, 4)) * (0.4 + 0.6 * k), a: k * k, color });
  };
  for (let n = 0; n < 70; n++) emit(SCAN_FROM + (n / 70) * (SCAN_TO - SCAN_FROM - 0.1), n, false, "#9DA8F8");
  PIN_TIMES.forEach((pt, i) => {
    for (let n = 0; n < 22; n++) emit(pt + n * 0.004, 500 + i * 50 + n, true, i === BEST_PIN ? "#4CC38A" : "#9DA8F8");
  });
  return out;
}

function i01(t: number, a: number, b: number) {
  return t >= a && t <= b ? 1 : 0;
}

export type HeroState = ReturnType<typeof heroState>;
