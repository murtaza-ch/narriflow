/* Canvas 2D drawing kit shared by every stage composition. */
import { clamp, ease } from "./math";
import { P, PRESETS, type Preset, type PresetId } from "./palette";
import { podcastScene } from "./scene";
import { cueAt, formatWord, SCRIPT, type Script } from "./script";
import type { Rect } from "./hero";
import { drawOps } from "./paint";

export type Ctx = CanvasRenderingContext2D;
export type Crop = { cx: number; cy: number; w: number; h: number };

/** A composition: a pure function of time drawn in its own coordinate space. */
export type Comp = {
  id: string;
  width: number;
  height: number;
  fps: number;
  /** Loop length in seconds. */
  duration: number;
  draw: (ctx: Ctx, t: number, opts?: DrawOptions) => void;
};
export type DrawOptions = {
  /** Clock for ambient life (breathing, bokeh, steam) when t is scrubbed. */
  ambient?: number;
  /** Draw the built-in stage chrome such as the hero stepper. Default true. */
  chrome?: boolean;
  /** Paint the composition's own background. Default true. */
  backdrop?: boolean;
};

/*
 * Font families. The Node renderer registers fonts under these names; a
 * browser page passes the families its own @font-face rules resolve to.
 */
export let MONO = '"Geist Mono"';
export let DISPLAY = "Archivo";
const captionFamilies: Record<string, string> = {};
export function configureFonts(fonts: { mono?: string; display?: string; captions?: Record<string, string> }) {
  if (fonts.mono) MONO = fonts.mono;
  if (fonts.display) DISPLAY = fonts.display;
  Object.assign(captionFamilies, fonts.captions ?? {});
}
const captionFamily = (name: string) => captionFamilies[name] ?? `"${name}"`;

export function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

export function text(
  ctx: Ctx,
  s: string,
  x: number,
  y: number,
  o: { font: string; color: string; align?: CanvasTextAlign; spacing?: number; baseline?: CanvasTextBaseline },
) {
  ctx.font = o.font;
  ctx.fillStyle = o.color;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = o.baseline ?? "middle";
  ctx.letterSpacing = `${o.spacing ?? 0}px`;
  ctx.fillText(s, x, y);
  ctx.letterSpacing = "0px";
}

export function measure(ctx: Ctx, s: string, font: string, spacing = 0) {
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  const w = ctx.measureText(s).width;
  ctx.letterSpacing = "0px";
  return w;
}

export const mono = (size: number, weight = 500) => `${weight} ${size}px ${MONO}`;

/** Upper-case mono microcopy with tracking. */
export function label(ctx: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", track = 0.1) {
  text(ctx, s.toUpperCase(), x, y, { font: mono(size), color, align, spacing: size * track });
}

export function chip(ctx: Ctx, s: string, x: number, y: number, size: number, color: string, bg = "rgba(8,9,12,0.72)", anchor: "left" | "right" = "left") {
  const w = measure(ctx, s.toUpperCase(), mono(size), size * 0.1) + size * 1.1;
  const h = size * 1.7;
  const left = anchor === "left" ? x : x - w;
  rr(ctx, left, y - h / 2, w, h, size * 0.45);
  ctx.fillStyle = bg;
  ctx.fill();
  label(ctx, s, left + size * 0.55, y + 0.5, size, color);
  return w;
}

export function backdrop(ctx: Ctx, w: number, h: number, breathe: number, glow: [number, number] = [0.5, 0.48], grid = 48) {
  ctx.fillStyle = P.night;
  ctx.fillRect(0, 0, w, h);
  // grid, radially faded
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.028)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += grid) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += grid) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
  const fade = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.62);
  fade.addColorStop(0.45, "rgba(8,9,12,0)");
  fade.addColorStop(1, "rgba(8,9,12,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  // bloom
  ctx.save();
  ctx.translate(w * glow[0], h * glow[1]);
  ctx.scale(1, (h * 0.52) / (w * 0.48));
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.48);
  g.addColorStop(0, `rgba(91,108,255,${0.16 + 0.05 * breathe})`);
  g.addColorStop(1, "rgba(91,108,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-w, -w, w * 2, w * 2);
  ctx.restore();
}

/** Paint the podcast set so `crop` (source px) fills `rect` (screen px). */
export function footage(
  ctx: Ctx,
  rect: Rect,
  t: number,
  st: number,
  loop: number,
  crop: Crop = { cx: 960, cy: 540, w: 1920, h: 1080 },
  script: Script = SCRIPT,
) {
  ctx.save();
  ctx.translate(rect.x, rect.y);
  ctx.scale(rect.w / crop.w, rect.h / crop.h);
  ctx.translate(-(crop.cx - crop.w / 2), -(crop.cy - crop.h / 2));
  drawOps(ctx, podcastScene(t, st, loop, script));
  ctx.restore();
}

/** Word-synced caption cue in a real preset, centred on cx with its top at y. */
export function caption(
  ctx: Ctx,
  st: number,
  preset: PresetId | Preset,
  cx: number,
  y: number,
  fs: number,
  maxWidth: number,
  script: Script = SCRIPT,
) {
  const hit = cueAt(st, script);
  if (!hit) return;
  const p: Preset = typeof preset === "string" ? PRESETS[preset] : preset;
  const font = `${p.weight} ${fs}px ${captionFamily(p.font)}`;
  const spacing = p.letterSpacing * fs;
  const words = hit.cue.words.map((w) => formatWord(w.text, p.transform, p.punctuation));
  const widths = words.map((w) => measure(ctx, w, font, spacing));
  const gap = fs * 0.26;
  const lines: number[][] = [[]];
  let lw = 0;
  words.forEach((_, i) => {
    const current = lines[lines.length - 1]!;
    const add = (current.length ? gap : 0) + widths[i]!;
    if (lw + add > maxWidth && current.length) {
      lines.push([i]);
      lw = widths[i]!;
    } else {
      current.push(i);
      lw += add;
    }
  });
  const enter = ease.out(clamp(hit.enter / 0.12));
  const lh = fs * 1.13;
  const stroke = p.outlineWidth === 0 ? 0 : Math.max(2, fs * 0.035 * (p.outlineWidth ?? 3));
  ctx.save();
  ctx.globalAlpha *= enter;
  ctx.translate(0, (1 - enter) * fs * 0.3);
  if (p.background) {
    const widest = Math.max(...lines.map((line) => line.reduce((a, i, k) => a + widths[i]! + (k ? gap : 0), 0)));
    rr(ctx, cx - widest / 2 - fs * 0.4, y - fs * 0.12, widest + fs * 0.8, lh * lines.length + fs * 0.24, fs * 0.3);
    ctx.fillStyle = p.background;
    ctx.fill();
  }
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  lines.forEach((line, li) => {
    const total = line.reduce((a, i, k) => a + widths[i]! + (k ? gap : 0), 0);
    let x = cx - total / 2;
    const ly = y + lh * li + lh / 2;
    line.forEach((i) => {
      const w = hit.cue.words[i]!;
      const word = words[i]!;
      const ww = widths[i]!;
      const active = i === hit.active;
      const pop = active ? 1 + 0.2 * (1 - ease.out(clamp((st - w.start) / 0.16))) : 1;
      const wx = x + ww / 2;
      ctx.save();
      ctx.translate(wx, ly);
      ctx.scale(pop, pop);
      const boxed = Boolean(p.box) && active;
      if (boxed) {
        rr(ctx, -ww / 2 - fs * 0.14, -lh / 2 + fs * 0.02, ww + fs * 0.28, lh - fs * 0.04, fs * 0.14);
        ctx.fillStyle = p.box!;
        ctx.fill();
      } else if (stroke > 0) {
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = fs * 0.12;
        ctx.shadowOffsetY = fs * 0.06;
        ctx.strokeStyle = p.outline;
        ctx.lineWidth = stroke;
        ctx.strokeText(word, 0, fs * 0.04);
        ctx.shadowColor = "transparent";
      }
      if (p.glow) {
        ctx.shadowColor = p.glow;
        ctx.shadowBlur = fs * 0.35;
        ctx.shadowOffsetY = 0;
      }
      ctx.fillStyle = active ? p.highlight : p.primary;
      ctx.fillText(word, 0, fs * 0.04);
      ctx.restore();
      x += ww + gap;
    });
  });
  ctx.letterSpacing = "0px";
  ctx.restore();
}

export function scoreBadge(ctx: Ctx, score: number, right: number, top: number, size: number, best = false) {
  const w = size * 2.1;
  const h = size * 2.05;
  const x = right - w;
  rr(ctx, x, top, w, h, size * 0.3);
  ctx.fillStyle = "rgba(8,9,12,0.72)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();
  label(ctx, "Score", right - size * 0.36, top + size * 0.46, size * 0.36, P.fgMuted, "right", 0.14);
  text(ctx, String(score), right - size * 0.36, top + size * 1.12, {
    font: `600 ${size}px ${MONO}`,
    color: best ? P.success : P.fg,
    align: "right",
  });
  const mw = size * 1.3;
  const my = top + size * 1.66;
  rr(ctx, right - size * 0.36 - mw, my, mw, Math.max(3, size * 0.1), 99);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fill();
  rr(ctx, right - size * 0.36 - mw, my, (mw * score) / 100, Math.max(3, size * 0.1), 99);
  ctx.fillStyle = best ? P.success : P.accent;
  ctx.fill();
}

export function check(ctx: Ctx, cx: number, cy: number, size: number, p: number, color: string = P.success) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(p, p);
  ctx.beginPath();
  ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  const k = size / 24;
  ctx.beginPath();
  ctx.moveTo(-5 * k, 0.5 * k);
  ctx.lineTo(-1.8 * k, 3.7 * k);
  ctx.lineTo(5 * k, -3 * k);
  ctx.strokeStyle = "#08130D";
  ctx.lineWidth = 2.6 * k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

/** Rendered vertical clip: footage crop + caption + score + progress. */
export function clipCard(
  ctx: Ctx,
  o: {
    rect: Rect;
    t: number;
    st: number;
    loop: number;
    crop: Crop;
    preset: PresetId;
    score: number;
    chrome: number;
    captionAlpha: number;
    progress: number;
    rot?: number;
    alpha?: number;
    best?: boolean;
    shine?: number;
  },
) {
  const { rect, chrome } = o;
  const k = rect.w / 486;
  const r = 26 * k * chrome;
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.rotate(((o.rot ?? 0) * Math.PI) / 180);
  ctx.translate(-rect.w / 2, -rect.h / 2);
  const local = { x: 0, y: 0, w: rect.w, h: rect.h };
  // shadow
  if (chrome > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.55 * chrome})`;
    ctx.shadowBlur = 90 * k;
    ctx.shadowOffsetY = 40 * k;
    rr(ctx, 0, 0, rect.w, rect.h, r);
    ctx.fillStyle = P.night;
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  rr(ctx, 0, 0, rect.w, rect.h, r);
  ctx.clip();
  footage(ctx, local, o.t, o.st, o.loop, o.crop);
  if (o.captionAlpha > 0) {
    ctx.save();
    ctx.globalAlpha *= o.captionAlpha;
    caption(ctx, o.st, o.preset, rect.w / 2, rect.h * 0.64, 60 * k, rect.w * 0.88);
    ctx.restore();
  }
  ctx.globalAlpha *= chrome;
  scoreBadge(ctx, o.score, rect.w - 20 * k, 20 * k, 40 * k, o.best);
  rr(ctx, 22 * k, rect.h - 27 * k, rect.w - 44 * k, 5 * k, 99);
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fill();
  rr(ctx, 22 * k, rect.h - 27 * k, (rect.w - 44 * k) * o.progress, 5 * k, 99);
  ctx.fillStyle = P.fg;
  ctx.fill();
  const sh = o.shine ?? 0;
  if (sh > 0 && sh < 1) {
    ctx.globalAlpha = o.alpha ?? 1;
    ctx.globalCompositeOperation = "screen";
    ctx.translate(rect.w * (-0.45 + 1.5 * sh) + rect.w * 0.19, rect.h / 2);
    ctx.rotate((16 * Math.PI) / 180);
    const bw = rect.w * 0.38;
    const g = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.2)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-bw / 2, -rect.h * 0.7, bw, rect.h * 1.4);
  }
  ctx.restore();
  if (chrome > 0) {
    rr(ctx, 0, 0, rect.w, rect.h, r);
    ctx.strokeStyle = `rgba(255,255,255,${0.12 * chrome})`;
    ctx.lineWidth = 2 * chrome;
    ctx.stroke();
  }
  ctx.restore();
}

/** Additive glowing dots (sparks, embers). */
export function sparks(ctx: Ctx, list: Array<{ x: number; y: number; r: number; a: number; color: string }>, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const p of list) {
    ctx.globalAlpha = alpha * p.a;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = p.r * 4;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
