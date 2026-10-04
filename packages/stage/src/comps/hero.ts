import { P } from "../palette";
import { ease, osc, ramp, tc } from "../math";
import { barAmp, barHeat, BARS, CENTER_SHIP, CHIP_Y, HERO, heroState, STEPS, TIMELINE, type HeroState } from "../hero";
import { formatWord, SCRIPT, SCRIPT_DURATION, speakerAt } from "../script";
import { backdrop, check, chip, clipCard, type Comp, DISPLAY, footage, label, measure, mono, rr, sparks, text, type Ctx } from "../kit";

const LOOP = HERO.duration;

function stepper(ctx: Ctx, s: HeroState) {
  ctx.save();
  ctx.globalAlpha *= s.stepperAlpha;
  const size = 22;
  const items = STEPS.map((step, i) => `${String(i + 1).padStart(2, "0")} ${step.label}`.toUpperCase());
  const widths = items.map((x) => measure(ctx, x, mono(size), size * 0.16) + 26);
  const total = widths.reduce((a, b) => a + b, 0) + 44 * (items.length - 1);
  let x = 960 - total / 2;
  items.forEach((item, i) => {
    const on = i === s.step;
    const done = s.step > i || s.step === -1;
    ctx.save();
    if (on) {
      ctx.shadowColor = P.accent;
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = on ? P.accent : done ? P.fgMuted : "transparent";
    ctx.fillRect(x, 60, 12, 12);
    ctx.restore();
    ctx.strokeStyle = on ? P.accent : P.borderStrong;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 61, 10, 10);
    text(ctx, item, x + 26, 67, { font: mono(size), color: on ? P.fg : P.fgSubtle, spacing: size * 0.16 });
    x += widths[i]! + 44;
  });
  ctx.restore();
}

function timeline(ctx: Ctx, s: HeroState) {
  const { x, y, w, h } = TIMELINE;
  const pitch = w / BARS;
  ctx.save();
  ctx.globalAlpha *= s.timelineAlpha;
  for (let i = 0; i < BARS; i++) {
    const p = i / (BARS - 1);
    const scanned = p <= s.scan;
    const heat = barHeat(i) * (scanned ? 1 : 0);
    const bh = 8 + barAmp(i) * (h - 18);
    ctx.globalAlpha = s.timelineAlpha * (0.55 + 0.45 * Math.max(heat, scanned ? 0.4 : 0));
    ctx.fillStyle =
      heat > 0.35 ? (heat > 0.6 && Math.abs(p - 0.53) < 0.06 ? P.success : P.accent) : scanned ? "#4A5263" : "#2A303B";
    rr(ctx, x + i * pitch, y + (h - bh) / 2, pitch * 0.5, bh, 3);
    ctx.fill();
  }
  ctx.globalAlpha = s.timelineAlpha;
  // scan head: additive trail + glowing line
  const hx = x + s.scan * w;
  if (s.scanHeadAlpha > 0) {
    ctx.save();
    ctx.globalAlpha *= s.scanHeadAlpha;
    ctx.globalCompositeOperation = "lighter";
    const tr = ctx.createLinearGradient(hx - 220, 0, hx, 0);
    tr.addColorStop(0, "rgba(91,108,255,0)");
    tr.addColorStop(1, "rgba(91,108,255,0.3)");
    ctx.fillStyle = tr;
    ctx.fillRect(hx - 220, y - 14, 220, h + 28);
    ctx.shadowColor = P.accent;
    ctx.shadowBlur = 24;
    ctx.fillStyle = P.accentSoft;
    ctx.fillRect(hx - 1.5, y - 22, 3, h + 44);
    ctx.restore();
  }
  // pins
  s.pins.forEach((pin, i) => {
    if (pin.reveal <= 0) return;
    const best = i === 1;
    const px = x + pin.p * w;
    ctx.save();
    ctx.globalAlpha *= Math.min(1, pin.reveal) * (1 - 0.6 * pin.dim);
    ctx.translate(px, y - 64);
    const sc = 0.4 + 0.6 * pin.reveal;
    ctx.scale(sc, sc);
    const label = String(pin.count);
    const bw = measure(ctx, label, `600 28px ${'"Geist Mono"'}`) + 28;
    if (best) {
      ctx.shadowColor = `rgba(76,195,138,${0.35 + 0.35 * s.pulse})`;
      ctx.shadowBlur = 20 + 30 * s.pulse;
    }
    rr(ctx, -bw / 2, 0, bw, 44, 10);
    ctx.fillStyle = best ? P.success : P.raised;
    ctx.fill();
    ctx.shadowColor = "transparent";
    text(ctx, label, 0, 23, { font: `600 28px "Geist Mono"`, color: best ? "#07140D" : P.fg, align: "center" });
    ctx.fillStyle = best ? P.success : P.borderStrong;
    ctx.fillRect(-1, 44, 2, 40);
    ctx.restore();
  });
  const ly = y + h + 28;
  label(ctx, "00:00:00", x, ly, 20, P.fgSubtle);
  label(ctx, s.scan >= 1 ? "3 moments found" : `Scanning transcript · ${tc(s.headTimecode)}`, x + w / 2, ly, 20, s.scan >= 1 ? P.success : P.fgMuted, "center");
  label(ctx, "00:47:12", x + w, ly, 20, P.fgSubtle, "right");
  ctx.restore();
}

function sourceFrame(ctx: Ctx, s: HeroState) {
  const r = s.source;
  const k = r.w / 1216;
  ctx.save();
  ctx.globalAlpha *= s.sourceAlpha;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 80;
  ctx.shadowOffsetY = 30;
  rr(ctx, r.x, r.y, r.w, r.h, 18 * k);
  ctx.fillStyle = P.night;
  ctx.fill();
  ctx.restore();
  ctx.save();
  rr(ctx, r.x, r.y, r.w, r.h, 18 * k);
  ctx.clip();
  footage(ctx, r, s.t, s.st, LOOP);
  const c = s.cropScreen;
  if (s.cropWindowAlpha > 0) {
    ctx.save();
    ctx.globalAlpha *= s.cropWindowAlpha;
    // dim outside the crop (even-odd cut-out)
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.rect(c.x, c.y, c.w, c.h);
    ctx.fillStyle = "rgba(6,7,10,0.58)";
    ctx.fill("evenodd");
    ctx.strokeStyle = "rgba(157,168,248,0.9)";
    ctx.lineWidth = 2 * k + 1;
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    chip(ctx, `9:16 · Speaker ${speakerAt(s.st) === 0 ? "A" : "B"}`, c.x + 14 * k, c.y + 14 * k + Math.max(13, 18 * k) * 0.85, Math.max(13, 18 * k), "#fff", P.accent);
    ctx.restore();
  }
  const fs = Math.max(13, 19 * k);
  chip(ctx, "ep142.mp4", r.x + 18 * k, r.y + r.h - 16 * k - fs * 0.85, fs, P.fgMuted);
  chip(ctx, tc(s.sourceTimecode), r.x + r.w - 18 * k, r.y + r.h - 16 * k - fs * 0.85, fs, P.timecode, undefined, "right");
  ctx.restore();
  rr(ctx, r.x, r.y, r.w, r.h, 18 * k);
  ctx.strokeStyle = P.border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function transcript(ctx: Ctx, s: HeroState) {
  if (s.transcriptAlpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= s.transcriptAlpha;
  ctx.translate((1 - s.transcriptAlpha) * 30, 0);
  const x0 = 1300;
  let y = 372;
  label(ctx, "Transcript · word-synced", x0, y, 20, P.fgSubtle, "left", 0.18);
  y += 40;
  const font = `600 30px ${DISPLAY}`;
  for (let li = 0; li < 3; li++) {
    const words = SCRIPT.words.filter((w) => w.line === li);
    const speaker = words[0]?.speaker ?? 0;
    label(ctx, speaker === 0 ? "A" : "B", x0, y + 20, 18, speaker === 0 ? P.warm : P.accentSoft);
    let x = x0 + 48;
    for (const w of words) {
      const s2 = formatWord(w.text, "none");
      const ww = measure(ctx, s2, font);
      if (x + ww > x0 + 520) {
        x = x0 + 48;
        y += 43;
      }
      const said = s.st >= w.start;
      const active = s.st >= w.start && s.st <= w.end + 0.05;
      if (active) {
        rr(ctx, x - 5, y + 1, ww + 10, 38, 6);
        ctx.fillStyle = "#00FF88";
        ctx.fill();
      }
      text(ctx, s2, x, y + 21, { font, color: active ? "#07140D" : said ? P.fg : "#434B59" });
      x += ww + 11;
    }
    y += 43 + 26;
  }
  ctx.restore();
}

function shipChip(ctx: Ctx, cx: number, y: number, show: number, chk: number, ring: number, platform: string, when: string) {
  if (show <= 0) return;
  const pf = `600 22px ${DISPLAY}`;
  const wp = measure(ctx, platform, pf);
  const ww = measure(ctx, when.toUpperCase(), mono(18), 1.8);
  const w = 12 + 26 + 12 + wp + 12 + ww + 16;
  const h = 48;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, show);
  ctx.translate(cx, y + h / 2 + (1 - Math.min(1, show)) * 20);
  const sc = 0.9 + 0.1 * show;
  ctx.scale(sc, sc);
  rr(ctx, -w / 2, -h / 2, w, h, 99);
  ctx.fillStyle = P.surface;
  ctx.fill();
  ctx.strokeStyle = P.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  let x = -w / 2 + 12;
  check(ctx, x + 13, 0, 26, chk > 0.01 ? chk : 1, chk > 0.01 ? P.success : P.raised);
  if (ring > 0 && ring < 1) {
    ctx.beginPath();
    ctx.arc(x + 13, 0, 13 + 30 * ring, 0, Math.PI * 2);
    ctx.strokeStyle = P.success;
    ctx.globalAlpha *= 1 - ring;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha /= 1 - ring;
  }
  x += 26 + 12;
  text(ctx, platform, x, 1, { font: pf, color: P.fg });
  x += wp + 12;
  label(ctx, when, x, 1, 18, P.fgMuted);
  ctx.restore();
}

export const hero: Comp = {
  id: "hero",
  width: HERO.width,
  height: HERO.height,
  fps: HERO.fps,
  duration: HERO.duration,
  draw: (ctx, t, opts) => {
    // footage and ambience follow `ambient` when the story time is scrubbed
    const amb = opts?.ambient ?? t;
    const s = { ...heroState(t), t: amb };
    if (opts?.backdrop !== false) backdrop(ctx, 1920, 1080, osc(amb, 5, LOOP), [0.5, 0.52]);
    if (opts?.chrome !== false) stepper(ctx, s);
    timeline(ctx, s);
    sparks(ctx, s.sparks, s.timelineAlpha);
    sourceFrame(ctx, s);
    transcript(ctx, s);
    s.siblings.forEach((sib, i) => {
      if (s.siblingAlpha > 0)
        clipCard(ctx, {
          rect: sib.rect,
          rot: sib.rot,
          alpha: sib.alpha,
          t: amb,
          st: sib.st,
          loop: LOOP,
          crop: sib.crop,
          preset: sib.preset,
          score: sib.score,
          chrome: 1,
          captionAlpha: 1,
          progress: sib.st / SCRIPT_DURATION,
          shine: s.siblingShine,
        });
      const c = s.chips[i === 0 ? 0 : 2]!;
      shipChip(ctx, sib.rect.x + sib.rect.w / 2, CHIP_Y, c.show, c.check, c.ring, sib.platform, sib.when);
    });
    if (s.clipVisible) {
      clipCard(ctx, {
        rect: s.clip,
        t: amb,
        st: s.st,
        loop: LOOP,
        crop: s.crop,
        preset: "karaoke",
        score: s.clipScore,
        chrome: s.clipChrome,
        captionAlpha: s.captionAlpha,
        progress: s.st / SCRIPT_DURATION,
        best: true,
        shine: s.clipShine,
      });
      const center = s.chips[1]!;
      shipChip(ctx, 960, CHIP_Y, center.show, center.check, center.ring, CENTER_SHIP.platform, CENTER_SHIP.when);
    }
    const flash = Math.min(ramp(t, 4.3, 4.7), 1 - ramp(t, 4.7, 5.4, ease.out));
    if (flash > 0) {
      ctx.save();
      ctx.globalAlpha = flash;
      const g = ctx.createRadialGradient(960, 540, 0, 960, 540, 1100);
      g.addColorStop(0, "rgba(157,168,248,0.18)");
      g.addColorStop(1, "rgba(157,168,248,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.restore();
    }
  },
};
