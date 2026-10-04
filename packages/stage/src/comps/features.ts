/* The six homepage capability loops, painted with Canvas 2D. */
import { P, PRESETS } from "../palette";
import { clamp, lerp, osc } from "../math";
import { brollScene } from "../scene";
import { SCRIPT } from "../script";
import { cropFor } from "../hero";
import {
  CAL,
  captionsState,
  DAYS,
  LOOP,
  MOMENTS,
  momentsState,
  NOTES,
  publishState,
  RATIOS,
  ratiosState,
  reframeState,
  repurposeState,
  SLOTS,
  SQUARE,
  WIDE,
} from "../features";
import { drawOps } from "../paint";
import { backdrop, caption, chip, type Comp, DISPLAY, footage, label, measure, MONO, mono, rr, text, type Ctx } from "../kit";

const edgeFade = (ctx: Ctx, w: number, h: number, size = 160) => {
  const l = ctx.createLinearGradient(0, 0, size, 0);
  l.addColorStop(0, P.night);
  l.addColorStop(1, "rgba(8,9,12,0)");
  ctx.fillStyle = l;
  ctx.fillRect(0, 0, size, h);
  const r = ctx.createLinearGradient(w - size, 0, w, 0);
  r.addColorStop(0, "rgba(8,9,12,0)");
  r.addColorStop(1, P.night);
  ctx.fillStyle = r;
  ctx.fillRect(w - size, 0, size, h);
};

/* ————— 01 Moments ————— */
export const moments: Comp = {
  id: "moments",
  ...WIDE,
  fps: 30,
  duration: LOOP,
  draw: (ctx, t) => {
    const s = momentsState(t);
    const { riverY, riverH, gateX, pitch } = MOMENTS;
    backdrop(ctx, 1280, 720, osc(t, 3.75, LOOP), [0.5, 0.58], 40);
    label(ctx, "Moment detection", 64, 62, 22, P.fgSubtle, "left", 0.16);
    label(ctx, "ep142.mp4 · 47:12", 1216, 62, 22, P.fgMuted, "right");

    // scanned field glow left of the gate
    const field = ctx.createLinearGradient(gateX - 420, 0, gateX, 0);
    field.addColorStop(0, "rgba(91,108,255,0)");
    field.addColorStop(1, "rgba(91,108,255,0.10)");
    ctx.fillStyle = field;
    ctx.fillRect(gateX - 420, riverY - riverH / 2 - 20, 420, riverH + 40);

    for (const b of s.bars) {
      const bh = 10 + b.amp * (riverH - 20);
      const region = b.region >= 0 ? MOMENTS.regions[b.region] : null;
      let color = b.scanned ? "#465062" : "#262C36";
      if (b.scanned && b.heat > 0.3 && region) color = region.score >= 90 ? P.success : region.score >= 70 ? P.accent : "#5A6278";
      ctx.globalAlpha = b.scanned ? 0.55 + 0.45 * Math.max(0.4, b.heat) : 0.8;
      rr(ctx, b.x - pitch * 0.25, riverY - bh / 2, pitch * 0.5, bh, 3);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ticker of transcript words under the river
    for (const w of s.ticker) {
      text(ctx, w.word, w.x, riverY + riverH / 2 + 48, {
        font: `500 20px ${MONO}`,
        color: w.lit ? P.fg : w.x < gateX ? "#4A5263" : "#2E343F",
        align: "center",
      });
    }

    // gate
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = P.accent;
    ctx.shadowBlur = 30 + 10 * s.gatePulse;
    ctx.fillStyle = P.accentSoft;
    ctx.fillRect(gateX - 1.5, riverY - riverH / 2 - 34, 3, riverH + 68);
    ctx.restore();
    chip(ctx, "AI scan", gateX - 52, riverY + riverH / 2 + 92, 18, "#fff", P.accent);

    // moment cards riding the river
    for (const c of s.cards) {
      const w = 236;
      const h = 124;
      const x = c.x - w / 2;
      const y = riverY - riverH / 2 - 40 - h;
      const tone = c.best ? P.success : c.low ? "#5A6278" : P.accent;
      ctx.save();
      ctx.globalAlpha = clamp(c.pop) * (c.low ? 0.6 : 1);
      ctx.translate(c.x, y + h);
      const sc = 0.5 + 0.5 * c.pop;
      ctx.scale(sc, sc);
      ctx.translate(-c.x, -(y + h));
      // stem to the river
      ctx.fillStyle = tone;
      ctx.fillRect(c.x - 1, y + h, 2, 40);
      if (c.flash > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha *= c.flash;
        const g = ctx.createRadialGradient(c.x, riverY, 0, c.x, riverY, 150);
        g.addColorStop(0, c.best ? "rgba(76,195,138,0.5)" : "rgba(91,108,255,0.45)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(c.x - 150, riverY - 150, 300, 300);
        ctx.restore();
      }
      if (c.best) {
        ctx.shadowColor = "rgba(76,195,138,0.35)";
        ctx.shadowBlur = 40;
      }
      rr(ctx, x, y, w, h, 14);
      ctx.fillStyle = P.surface;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = c.best ? "rgba(76,195,138,0.6)" : P.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      label(ctx, c.label, x + 20, y + 28, 16, tone, "left", 0.14);
      label(ctx, c.tc, x + w - 20, y + 28, 18, P.timecode, "right", 0.04);
      text(ctx, String(c.count), x + 20, y + 76, { font: `600 50px ${MONO}`, color: c.low ? P.fgMuted : P.fg });
      rr(ctx, x + 20, y + h - 20, w - 40, 5, 99);
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fill();
      rr(ctx, x + 20, y + h - 20, ((w - 40) * c.count) / 100, 5, 99);
      ctx.fillStyle = tone;
      ctx.fill();
      ctx.restore();
    }
    edgeFade(ctx, 1280, 720, 180);
  },
};

/* ————— 02 Captions ————— */
export const captions: Comp = {
  id: "captions",
  ...WIDE,
  fps: 30,
  duration: LOOP,
  draw: (ctx, t) => {
    const s = captionsState(t);
    backdrop(ctx, 1280, 720, osc(t, 3.75, LOOP), [0.5, 0.45], 40);
    const fw = 300;
    const fh = 533;
    const gap = 44;
    const x0 = (1280 - (fw * 3 + gap * 2)) / 2;
    const y0 = 44;
    const crop = cropFor(s.focus);
    s.frames.forEach((f, i) => {
      const x = x0 + i * (fw + gap);
      const y = y0 + f.bob;
      ctx.save();
      ctx.translate(x + fw / 2, y + fh / 2);
      ctx.scale(f.flip, 1);
      ctx.translate(-fw / 2, -fh / 2);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 50;
      ctx.shadowOffsetY = 24;
      rr(ctx, 0, 0, fw, fh, 20);
      ctx.fillStyle = P.night;
      ctx.fill();
      ctx.restore();
      rr(ctx, 0, 0, fw, fh, 20);
      ctx.save();
      ctx.clip();
      footage(ctx, { x: 0, y: 0, w: fw, h: fh }, t, s.st, LOOP, crop);
      caption(ctx, s.st, f.preset, fw / 2, fh * 0.62, 42, fw * 0.86);
      ctx.restore();
      rr(ctx, 0, 0, fw, fh, 20);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      // preset label
      const p = PRESETS[f.preset];
      ctx.save();
      ctx.globalAlpha = f.flip;
      const lw = measure(ctx, p.name.toUpperCase(), mono(18), 1.8) + 22;
      const lx = x + fw / 2 - lw / 2;
      ctx.beginPath();
      ctx.arc(lx + 6, y0 + fh + 36, 6, 0, Math.PI * 2);
      ctx.fillStyle = "box" in p ? (p as { box: string }).box : p.highlight;
      ctx.fill();
      label(ctx, p.name, lx + 22, y0 + fh + 37, 18, P.fgMuted);
      ctx.restore();
    });
    // word clock: one tick per word, the playhead lights them in sync
    const tx = x0;
    const tw = fw * 3 + gap * 2;
    const ty = 676;
    for (const w of SCRIPT.words) {
      const a = tx + (w.start / LOOP) * tw;
      const b = tx + (w.end / LOOP) * tw;
      const on = s.st >= w.start && s.st <= w.end;
      const said = s.st > w.end;
      rr(ctx, a, ty - (on ? 5 : 3), Math.max(3, b - a - 2), on ? 10 : 6, 99);
      ctx.fillStyle = on ? "#00FF88" : said ? "#5A6278" : "#2A303B";
      ctx.fill();
    }
    const px = tx + s.progress * tw;
    ctx.save();
    ctx.shadowColor = P.accent;
    ctx.shadowBlur = 14;
    ctx.fillStyle = P.accentSoft;
    ctx.fillRect(px - 1, ty - 14, 2, 28);
    ctx.restore();
  },
};

/* ————— 03 Ratios ————— */
const cropForAspect = (aspect: number, focus: number) => {
  let h = aspect >= 1.5 ? 1080 : aspect >= 1 ? 1000 : 900;
  let w = h * aspect;
  if (w > 1920) {
    w = 1920;
    h = w / aspect;
  }
  const pull = clamp((1.7 - aspect) / 0.8);
  const cx = clamp(lerp(960, focus, pull), w / 2, 1920 - w / 2);
  return { cx, cy: 540, w, h };
};

export const ratios: Comp = {
  id: "ratios",
  ...SQUARE,
  fps: 30,
  duration: LOOP,
  draw: (ctx, t) => {
    const s = ratiosState(t);
    backdrop(ctx, 720, 720, osc(t, 3.75, LOOP), [0.5, 0.42], 36);
    const { box } = s;
    // ghost outlines of every ratio
    s.ghosts.forEach((g, i) => {
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = i === s.current ? "rgba(157,168,248,0.28)" : "rgba(255,255,255,0.09)";
      ctx.lineWidth = 1.5;
      rr(ctx, box.cx - g.w / 2, box.cy - g.h / 2, g.w, g.h, 12);
      ctx.stroke();
      ctx.restore();
    });
    const r = s.rect;
    const aspect = r.w / r.h;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 26;
    rr(ctx, r.x, r.y, r.w, r.h, 14);
    ctx.fillStyle = P.night;
    ctx.fill();
    ctx.restore();
    ctx.save();
    rr(ctx, r.x, r.y, r.w, r.h, 14);
    ctx.clip();
    footage(ctx, r, t, s.st, LOOP, cropForAspect(aspect, s.focus));
    caption(ctx, s.st, "karaoke", r.x + r.w / 2, r.y + r.h * 0.66, clamp(Math.min(r.w, r.h) * 0.11, 26, 44), r.w * 0.86);
    ctx.restore();
    rr(ctx, r.x, r.y, r.w, r.h, 14);
    ctx.strokeStyle = "rgba(157,168,248,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // rolling ratio label
    const cur = RATIOS[s.current]!;
    const nxt = RATIOS[s.next]!;
    const ly = 600;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, ly - 44, 720, 118);
    ctx.clip();
    for (const [item, off] of [
      [cur, -s.roll],
      [nxt, 1 - s.roll],
    ] as const) {
      ctx.globalAlpha = 1 - Math.abs(off);
      text(ctx, item.label, 360, ly + off * 70, { font: `600 64px ${MONO}`, color: P.fg, align: "center" });
      label(ctx, item.where, 360, ly + 52 + off * 70, 20, P.fgMuted, "center", 0.12);
    }
    ctx.restore();
  },
};

/* ————— 04 Reframe + B-roll ————— */
export const reframe: Comp = {
  id: "reframe",
  ...SQUARE,
  fps: 30,
  duration: LOOP,
  draw: (ctx, t) => {
    const s = reframeState(t);
    ctx.fillStyle = P.night;
    ctx.fillRect(0, 0, 720, 720);
    const full = { x: 0, y: 0, w: 720, h: 720 };
    footage(ctx, full, t, s.st, LOOP, s.view);
    const w = s.win;
    // dim outside the window
    ctx.beginPath();
    ctx.rect(0, 0, 720, 720);
    ctx.rect(w.x, w.y, w.w, w.h);
    ctx.fillStyle = "rgba(6,7,10,0.66)";
    ctx.fill("evenodd");
    // b-roll wipes into the window
    if (s.broll > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(w.x, w.y + w.h * (1 - s.broll), w.w, w.h * s.broll);
      ctx.clip();
      ctx.translate(w.x, w.y);
      const crop = { cx: 1040, cy: 540, w: (1080 * 9) / 16, h: 1080 };
      ctx.scale(w.w / crop.w, w.h / crop.h);
      ctx.translate(-(crop.cx - crop.w / 2), 0);
      drawOps(ctx, brollScene(t, LOOP));
      ctx.restore();
    }
    // face lock brackets
    const lockA = clamp(1 - s.broll * 2);
    if (lockA > 0) {
      ctx.save();
      ctx.globalAlpha = lockA;
      const bw = 124 + 6 * s.lock;
      const bh = 144 + 6 * s.lock;
      const bx = s.faceX - bw / 2 + 4;
      const by = s.faceY - bh / 2 - 8;
      ctx.strokeStyle = P.accentSoft;
      ctx.lineWidth = 3;
      const L = 22;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [
        [bx, by, 1, 1],
        [bx + bw, by, -1, 1],
        [bx, by + bh, 1, -1],
        [bx + bw, by + bh, -1, -1],
      ] as const) {
        ctx.moveTo(cx, cy + dy * L);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + dx * L, cy);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(157,168,248,0.95)";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
    const tag = s.broll > 0.5 ? "B-roll · city at dusk" : `Tracking · Speaker ${s.speaker === 0 ? "A" : "B"}`;
    chip(ctx, tag, clamp(w.x, 16, 720 - 16 - measure(ctx, tag.toUpperCase(), mono(17), 1.7) - 19), w.y - 28, 17, "#fff", s.broll > 0.5 ? "#8B5CF6" : P.accent);
    // shot timeline
    const tx = 48;
    const tw = 624;
    const ty = 674;
    const colors: Record<string, string> = { A: "#C98A45", B: P.accent, "B-roll": "#8B5CF6" };
    s.segments.forEach((seg) => {
      const a = tx + (seg.from / LOOP) * tw;
      const b = tx + (seg.to / LOOP) * tw;
      rr(ctx, a + 1, ty - 9, b - a - 2, 18, 5);
      ctx.fillStyle = colors[seg.kind] ?? P.accent;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (b - a > 70) label(ctx, seg.kind, a + 10, ty + 1, 12, "rgba(255,255,255,0.9)");
    });
    ctx.fillStyle = "#fff";
    ctx.fillRect(tx + s.playhead * tw - 1, ty - 16, 2, 32);
  },
};

/* ————— 05 Repurpose ————— */
const wrap = (ctx: Ctx, s: string, font: string, max: number) => {
  const words = s.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (measure(ctx, test, font) > max && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
};

export const repurpose: Comp = {
  id: "repurpose",
  ...SQUARE,
  fps: 30,
  duration: LOOP,
  draw: (ctx, t) => {
    const s = repurposeState(t);
    backdrop(ctx, 720, 720, osc(t, 3.75, LOOP), [0.5, 0.62], 36);
    // transcript source
    rr(ctx, 48, 40, 624, 118, 14);
    ctx.fillStyle = P.surface;
    ctx.fill();
    ctx.strokeStyle = P.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    label(ctx, "ep142 · transcript", 70, 66, 15, P.fgSubtle, "left", 0.16);
    const tl = ["nobody watches the whole forty minute episode.", "they watch the one minute that hits. so find it,"];
    tl.forEach((line, li) => {
      const y = 100 + li * 32;
      text(ctx, line, 70, y, { font: `500 19px ${MONO}`, color: "#6B7483" });
    });
    // sweep highlight across the transcript
    const sx = 70 + s.sweep * 580;
    const g = ctx.createLinearGradient(sx - 80, 0, sx + 20, 0);
    g.addColorStop(0, "rgba(91,108,255,0)");
    g.addColorStop(1, "rgba(91,108,255,0.35)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(sx - 80, 84, 100, 64);
    ctx.restore();

    // cards, back to front
    const order = [...s.cards].sort((a, b) => b.order - a.order);
    for (const c of order) {
      const d = c.depth;
      if (d > 3.6) continue;
      const cw = 500;
      const ch = 380;
      const sc = 1 - d * 0.06 + c.lift * 0.04;
      const cx = 360 + d * 20;
      const cy = 452 - d * 30 - c.lift * 150;
      const alpha = clamp(4 - d) * (1 - d * 0.18) * c.fade;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.scale(sc, sc);
      ctx.translate(-cw / 2, -ch / 2);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 40;
      ctx.shadowOffsetY = 18;
      rr(ctx, 0, 0, cw, ch, 18);
      ctx.fillStyle = d < 0.5 ? "#191D24" : P.surface;
      ctx.fill();
      ctx.restore();
      rr(ctx, 0, 0, cw, ch, 18);
      ctx.strokeStyle = d < 0.5 ? "rgba(157,168,248,0.45)" : P.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      chip(ctx, c.tag, 26, 40, 16, "#fff", d < 0.5 ? P.accent : P.raised);
      if (d > 0.6) {
        ctx.restore();
        continue;
      }
      ctx.globalAlpha *= 1 - clamp(d / 0.6);
      label(ctx, c.meta, cw - 26, 40, 15, P.fgSubtle, "right", 0.08);
      const p = c.isActive ? s.typed : 1;
      const tf = `700 30px ${DISPLAY}`;
      const typeText = (str: string, x: number, y: number, max: number, font = tf, color: string = P.fg, lh = 40) => {
        const lines = wrap(ctx, str, font, max);
        let budget = Math.floor(str.length * clamp(p * 1.6));
        lines.forEach((ln, li) => {
          const part = ln.slice(0, Math.max(0, budget));
          budget -= ln.length + 1;
          text(ctx, part, x, y + li * lh, { font, color });
          if (c.isActive && budget < 0 && budget > -ln.length - 1 && osc(t, 0.5, LOOP) > 0)
            ctx.fillRect(x + measure(ctx, part, font) + 3, y + li * lh - 16, 3, 32);
        });
        return lines.length;
      };
      const bars = (n: number, y: number, from: number) => {
        for (let k = 0; k < n; k++) {
          const full = [0.94, 0.88, 0.97, 0.7, 0.9][k % 5];
          const fill = clamp((p - from) * 2.2 - k * 0.18);
          rr(ctx, 26, y + k * 26, (cw - 52) * (full ?? 1) * fill, 10, 99);
          ctx.fillStyle = "#2E3440";
          ctx.fill();
        }
      };
      if (c.tag === "Blog post") {
        const n = typeText(c.title, 26, 104, cw - 52);
        bars(c.lines, 104 + n * 40 + 10, 0.45);
      } else if (c.tag === "X thread") {
        ctx.beginPath();
        ctx.arc(46, 104, 20, 0, Math.PI * 2);
        ctx.fillStyle = P.accent;
        ctx.fill();
        text(ctx, "Narriflow", 78, 97, { font: `700 20px ${DISPLAY}`, color: P.fg });
        label(ctx, "@narriflow", 78, 120, 14, P.fgSubtle);
        typeText(c.title, 26, 170, cw - 52, `600 26px ${DISPLAY}`, P.fg, 36);
        rr(ctx, 26, 290, cw - 52, 64, 12);
        ctx.strokeStyle = P.border;
        ctx.stroke();
        label(ctx, "2 / 6  ·  The one-minute rule", 44, 322, 15, P.fgMuted);
      } else if (c.tag === "LinkedIn") {
        const n = typeText(c.title, 26, 104, cw - 52);
        bars(c.lines, 104 + n * 40 + 10, 0.45);
        ["#4C8DF6", "#4CC38A", "#FF6B6B"].forEach((col, k) => {
          ctx.beginPath();
          ctx.arc(38 + k * 18, ch - 36, 9, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();
        });
        label(ctx, "248 reactions", 96, ch - 35, 14, P.fgMuted);
      } else {
        NOTES.forEach(([tc, line], k) => {
          const show = clamp(p * 3.2 - k * 0.9);
          ctx.save();
          ctx.globalAlpha *= show;
          ctx.translate((1 - show) * 20, 0);
          label(ctx, tc, 26, 110 + k * 76, 19, P.timecode, "left", 0.02);
          text(ctx, line, 26, 142 + k * 76, { font: `600 24px ${DISPLAY}`, color: P.fg });
          ctx.restore();
        });
      }
      ctx.restore();
    }
    // words flying from transcript into the active card
    ctx.save();
    for (const f of s.flying) {
      ctx.globalAlpha = f.a;
      chip(ctx, f.word, f.x - 30, f.y, 14, P.accentSoft, "rgba(91,108,255,0.18)");
    }
    ctx.restore();
  },
};

/* ————— 06 Publish ————— */
export const publish: Comp = {
  id: "publish",
  ...SQUARE,
  fps: 30,
  duration: LOOP,
  draw: (ctx, t) => {
    const s = publishState(t);
    backdrop(ctx, 720, 720, osc(t, 3.75, LOOP), [0.5, 0.5], 36);
    text(ctx, "This week", 48, 84, { font: `700 34px ${DISPLAY}`, color: P.fg });
    const sched = Math.round(lerp(s.scheduled, 0, s.slide));
    const live = Math.round(lerp(s.liveCount, 0, s.slide));
    const w1 = chip(ctx, `${sched} scheduled`, 672, 84, 16, P.fgMuted, P.surface, "right");
    chip(ctx, `${live} live`, 672 - w1 - 10, 84, 16, live ? "#07140D" : P.fgMuted, live ? P.success : P.surface, "right");
    const gx = CAL.x;
    const gy = CAL.y;
    DAYS.forEach((d, i) => {
      label(ctx, d, gx + CAL.colW * i + CAL.colW / 2, gy + 16, 16, P.fgSubtle, "center", 0.12);
    });
    SLOTS.forEach((slot, r) => {
      const y = gy + CAL.headH + r * CAL.rowH;
      label(ctx, slot, gx - 12, y + 20, 14, P.fgSubtle, "right", 0.02);
      ctx.fillStyle = P.border;
      ctx.fillRect(gx, y, CAL.colW * 7, 1);
    });
    for (let i = 0; i <= 7; i++) {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(gx + CAL.colW * i, gy + CAL.headH, 1, CAL.rowH * 3);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(gx - 4, gy + CAL.headH - 4, CAL.colW * 7 + 8, CAL.rowH * 3 + 8);
    ctx.clip();
    ctx.translate(-s.slide * 720, 0);
    for (const p of s.posts) {
      if (p.drop <= 0) continue;
      const tw = 64;
      const th = 100;
      const x = p.cx - tw / 2;
      const y = gy + CAL.headH + p.slot * CAL.rowH + 12;
      ctx.save();
      ctx.globalAlpha = clamp(p.drop * 1.4);
      ctx.translate(p.cx, y + th / 2 - (1 - clamp(p.drop)) * 50);
      const sc = 0.6 + 0.4 * p.drop;
      ctx.scale(sc, sc);
      ctx.translate(-p.cx, -(y + th / 2));
      if (p.live > 0) {
        ctx.shadowColor = `rgba(76,195,138,${0.6 * p.live})`;
        ctx.shadowBlur = 22;
      }
      rr(ctx, x, y, tw, th, 8);
      ctx.fillStyle = P.night;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.save();
      rr(ctx, x, y, tw, th, 8);
      ctx.clip();
      footage(ctx, { x, y, w: tw, h: th }, t + p.n, t + p.n * 0.9, LOOP, cropFor(p.n % 2 ? 1280 : 640, 820));
      ctx.restore();
      rr(ctx, x, y, tw, th, 8);
      ctx.strokeStyle = p.live > 0.5 ? P.success : "rgba(255,255,255,0.14)";
      ctx.lineWidth = 2;
      ctx.stroke();
      // platform dot
      ctx.beginPath();
      ctx.arc(x + 11, y + 11, 5, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      if (p.live > 0.5) {
        const vw = measure(ctx, p.views, mono(13), 0.5);
        const vx = p.cx - vw / 2 + 6;
        ctx.beginPath();
        ctx.moveTo(vx - 14, y + th + 22);
        ctx.lineTo(vx - 9, y + th + 13);
        ctx.lineTo(vx - 4, y + th + 22);
        ctx.fillStyle = P.success;
        ctx.fill();
        label(ctx, p.views, vx, y + th + 18, 13, P.success, "left", 0.04);
      } else label(ctx, p.platform, p.cx, y + th + 18, 13, P.fgMuted, "center", 0.04);
      ctx.restore();
    }
    // now line
    if (s.nowAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = s.nowAlpha;
      ctx.shadowColor = P.accent;
      ctx.shadowBlur = 16;
      ctx.fillStyle = P.accentSoft;
      ctx.fillRect(s.nowX - 1, gy + CAL.headH - 4, 2, CAL.rowH * 3 + 8);
      ctx.restore();
    }
    ctx.restore();
    if (s.nowAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = s.nowAlpha;
      chip(ctx, "Now", s.nowX - s.slide * 720 - 24, gy + CAL.headH + CAL.rowH * 3 + 24, 13, "#fff", P.accent);
      ctx.restore();
    }
  },
};

export const FEATURES = [moments, captions, ratios, reframe, repurpose, publish];
