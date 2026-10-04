/*
 * Storyboards for the six homepage capability cards. All loops are 7.5 s
 * (one script pass) so footage, captions and motion wrap together.
 */
import { clamp, ease, lerp, mod, ramp, rand } from "./math";
import { focusX, SCRIPT_DURATION, speakerAt } from "./script";
import type { PresetId } from "./palette";

export const LOOP = SCRIPT_DURATION; // 7.5 s
export const WIDE = { width: 1280, height: 720 } as const;
export const SQUARE = { width: 720, height: 720 } as const;

/* ————— 01 Moments: a transcript river flowing through an AI scan gate ————— */
export const MOMENTS = {
  pitch: 10,
  period: 150, // bars per loop; speed = period * pitch / LOOP
  gateX: 640,
  riverY: 410,
  riverH: 170,
  regions: [
    { at: 22, width: 16, score: 92, tc: "12:41", label: "Top pick" },
    { at: 72, width: 12, score: 58, tc: "19:07", label: "Skipped" },
    { at: 118, width: 14, score: 84, tc: "31:05", label: "Clip" },
  ],
} as const;
const SPEED = (MOMENTS.period * MOMENTS.pitch) / LOOP;
/** Transcript words spaced so one sentence spans exactly one river period. */
const TICKER = (() => {
  const words = "the whole episode is raw material so find the one minute that hits then caption it and ship it".split(" ");
  const charW = 12; // Geist Mono at 20px
  const chars = words.reduce((a, w) => a + w.length, 0);
  const gap = (MOMENTS.period * MOMENTS.pitch - chars * charW) / words.length;
  let x = 0;
  return words.map((word) => {
    const at = x + (word.length * charW) / 2;
    x += word.length * charW + gap;
    return { word, at };
  });
})();

export function momentsState(t: number) {
  const { pitch, period, gateX, regions } = MOMENTS;
  const scroll = SPEED * t;
  // bar j sits at x = j*pitch - scroll + gateX (j may be negative)
  const first = Math.floor((scroll - gateX) / pitch) - 1;
  const last = first + Math.ceil(1280 / pitch) + 3;
  const bars: Array<{ x: number; amp: number; heat: number; region: number; scanned: boolean }> = [];
  for (let j = first; j <= last; j++) {
    const k = mod(j, period);
    let heat = 0;
    let region = -1;
    regions.forEach((r, ri) => {
      const d = Math.abs(k - r.at);
      const h = Math.exp(-((d / (r.width / 2.2)) ** 2));
      if (h > heat) {
        heat = h;
        region = ri;
      }
    });
    const talk = 0.16 + 0.34 * rand(k, 11) * (0.55 + 0.45 * Math.sin(k * 0.41));
    const amp = clamp(talk + heat * (0.5 + 0.18 * rand(k, 12)) * (regions[region]?.score ?? 0) / 92, 0.05, 1);
    const x = j * pitch - scroll + gateX;
    bars.push({ x, amp, heat, region, scanned: x < gateX });
  }
  // Each region crosses the gate once per loop; its card then rides the river.
  const cards = regions.flatMap((r, ri) => {
    const tc0 = (r.at * pitch) / SPEED; // time its centre crosses the gate (mod LOOP)
    return [-1, 0, 1]
      .map((k) => t - (tc0 + k * LOOP))
      .filter((age) => age >= 0 && age < 4.6)
      .map((age) => ({
        ri,
        ...r,
        x: gateX - age * SPEED,
        pop: ramp(age, 0, 0.5, ease.outBack),
        count: Math.round(r.score * ramp(age, 0.05, 0.7, ease.out)),
        flash: 1 - ramp(age, 0, 0.6),
        best: r.score >= 90,
        low: r.score < 70,
      }));
  });
  const ticker = [] as Array<{ x: number; word: string; lit: boolean }>;
  const cycle = period * pitch;
  const base = Math.floor((scroll - gateX) / cycle) - 1;
  for (let c = base; c <= base + 3; c++) {
    for (const w of TICKER) {
      const x = c * cycle + w.at - scroll + gateX;
      if (x < -80 || x > 1360) continue;
      const k = mod(w.at / pitch, period);
      const lit = regions.some((r) => Math.abs(k - r.at) < r.width / 1.6 && r.score >= 70) && x < gateX;
      ticker.push({ x, word: w.word, lit });
    }
  }
  return { bars, cards, ticker, gatePulse: 0.5 + 0.5 * Math.sin((t / LOOP) * Math.PI * 2 * 6) };
}

/* ————— 02 Captions: three frames, nine presets, one word clock ————— */
export const CAPTION_SETS: PresetId[][] = [
  ["karaoke", "highlighter", "fire"],
  ["neon", "electric", "sunset"],
  ["street", "luxe", "karaoke"],
];
export function captionsState(t: number) {
  const phaseLen = LOOP / CAPTION_SETS.length;
  const frames = [0, 1, 2].map((i) => {
    // each frame flips (squash → new preset → unsquash) slightly after its left neighbour
    // offset so the loop (and the poster frame) starts mid-phase, not mid-flip
    const lt = mod(t - i * 0.08 + 1.1, LOOP);
    const phase = Math.floor(lt / phaseLen) % CAPTION_SETS.length;
    const local = lt - phase * phaseLen;
    const flip = Math.min(ramp(local, 0, 0.18, ease.out), 1 - ramp(local, phaseLen - 0.18, phaseLen, ease.in));
    return {
      preset: CAPTION_SETS[phase]![i]!,
      flip: clamp(flip, 0.02, 1),
      bob: Math.sin((t / LOOP) * Math.PI * 2 * 2 + i * 1.9) * 5,
    };
  });
  // script runs 0.6 s ahead so the first frame (the poster) already shows a cue
  const st = mod(t + 0.6, LOOP);
  return { frames, st, focus: focusX(st), progress: st / LOOP };
}

/* ————— 03 Ratios: one frame morphing through every output ratio ————— */
export const RATIOS = [
  { label: "16:9", w: 16, h: 9, where: "YouTube" },
  { label: "1:1", w: 1, h: 1, where: "Feed posts" },
  { label: "9:16", w: 9, h: 16, where: "Shorts · Reels · TikTok" },
  { label: "4:5", w: 4, h: 5, where: "Instagram feed" },
] as const;
const RATIO_BOX = { w: 580, h: 470, cx: 360, cy: 300 };
const ratioSize = (r: { w: number; h: number }) => {
  const area = 580 * 326 * 0.92; // keep roughly constant visual weight
  let w = Math.sqrt((area * r.w) / r.h);
  let h = w * (r.h / r.w);
  const k = Math.min(1, RATIO_BOX.w / w, RATIO_BOX.h / h);
  w *= k;
  h *= k;
  return { w, h };
};
export function ratiosState(t: number) {
  const seg = LOOP / RATIOS.length;
  const i = Math.floor(t / seg) % RATIOS.length;
  const local = t - i * seg;
  const next = (i + 1) % RATIOS.length;
  const m = ramp(local, seg - 0.62, seg, ease.spring);
  const a = ratioSize(RATIOS[i]!);
  const b = ratioSize(RATIOS[next]!);
  const w = lerp(a.w, b.w, m);
  const h = lerp(a.h, b.h, m);
  return {
    rect: { x: RATIO_BOX.cx - w / 2, y: RATIO_BOX.cy - h / 2, w, h },
    ghosts: RATIOS.map((r) => ({ ...ratioSize(r), label: r.label })),
    box: RATIO_BOX,
    current: i,
    next,
    roll: ramp(local, seg - 0.45, seg - 0.05, ease.inOut),
    st: t,
    focus: focusX(t),
  };
}

/* ————— 04 Reframe + B-roll: a 9:16 window that follows the talker ————— */
export const REFRAME = { winH: 520, brollFrom: 4.25, brollTo: 5.55 } as const;
export function reframeState(t: number) {
  const st = t;
  const fx = focusX(st, 0.1, 0.5);
  // square view of the 1920×1080 source: 1080×1080 centred
  const view = { cx: 960, cy: 560, w: 1120, h: 1120 };
  const k = 720 / view.w;
  const left = view.cx - view.w / 2;
  const winW = (REFRAME.winH * 9) / 16;
  const win = { x: (fx - left) * k - winW / 2, y: 76, w: winW, h: REFRAME.winH };
  const broll = Math.min(ramp(t, REFRAME.brollFrom, REFRAME.brollFrom + 0.35, ease.inOut), 1 - ramp(t, REFRAME.brollTo, REFRAME.brollTo + 0.35, ease.inOut));
  const speaker = speakerAt(st);
  // shot segments for the mini timeline
  const segments = [
    { from: 0, to: 2.65, kind: "A" },
    { from: 2.65, to: REFRAME.brollFrom, kind: "B" },
    { from: REFRAME.brollFrom, to: REFRAME.brollTo, kind: "B-roll" },
    { from: REFRAME.brollTo, to: LOOP, kind: "A" },
  ];
  // face lock box around the active host's head, inside the window
  const faceX = (fx - left) * k;
  const lock = 0.5 + 0.5 * Math.sin((t / LOOP) * Math.PI * 2 * 5);
  return { view, win, broll, speaker, segments, st, faceX, faceY: (525 - (view.cy - view.h / 2)) * k, lock, playhead: t / LOOP };
}

/* ————— 05 Repurpose: four written assets typed out of one transcript ————— */
export const OUTPUTS = [
  { tag: "Blog post", meta: "SEO · 1,240 words", title: "Nobody watches the whole episode", lines: 5 },
  { tag: "X thread", meta: "1 / 6", title: "They watch the one minute that hits. Here is how we find it.", lines: 2 },
  { tag: "LinkedIn", meta: "Post · 180 words", title: "One recording. A week of posts.", lines: 4 },
  { tag: "Show notes", meta: "Timestamped", title: "", lines: 0 },
] as const;
export const NOTES = [
  ["00:04:12", "Why nobody finishes long episodes"],
  ["00:12:41", "The one-minute rule"],
  ["00:31:05", "Find it, caption it, ship it"],
] as const;
export function repurposeState(t: number) {
  const seg = LOOP / OUTPUTS.length;
  const active = Math.floor(t / seg) % OUTPUTS.length;
  const local = t - active * seg;
  const promote = ramp(local, 0, 0.5, ease.out); // everything shifts one slot forward
  const cards = OUTPUTS.map((o, i) => {
    // depth: 0 = front (active), 1..3 behind
    const depth = mod(i - active, OUTPUTS.length);
    if (depth === OUTPUTS.length - 1) {
      // the card that was just in front lifts away, then re-enters at the back
      const leaving = promote < 0.5;
      return {
        ...o,
        i,
        depth: leaving ? 0 : depth,
        order: leaving ? -1 : depth,
        lift: leaving ? ease.in(promote * 2) : 0,
        fade: leaving ? 1 - ease.in(promote * 2) : (promote - 0.5) * 2,
        isActive: false,
      };
    }
    const d = lerp(depth + 1, depth, promote);
    return { ...o, i, depth: d, order: d, lift: 0, fade: 1, isActive: depth === 0 };
  });
  const typed = ramp(local, 0.35, seg - 0.35, ease.linear);
  const flying = Array.from({ length: 5 }, (_, n) => {
    const t0 = 0.3 + (n / 5) * (seg - 1.0);
    const age = local - t0;
    if (age < 0 || age > 0.8) return null;
    const p = ease.inOut(age / 0.8);
    const x0 = 120 + rand(n + active * 9, 1) * 480;
    return {
      word: ["hook", "minute", "episode", "caption", "ship", "watch", "clip", "thread", "notes"][(n + active) % 9],
      x: lerp(x0, 360 + (rand(n, 2) - 0.5) * 160, p),
      y: lerp(150, 420, p) - Math.sin(p * Math.PI) * 50,
      a: Math.sin(p * Math.PI),
    };
  }).filter(Boolean) as Array<{ word: string; x: number; y: number; a: number }>;
  return { cards, active, typed, flying, sweep: mod(t / 2.5, 1) };
}

/* ————— 06 Publish: a week fills up, then goes live ————— */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const SLOTS = ["09:00", "12:30", "18:00"] as const;
export const POSTS = [
  { day: 0, slot: 0, platform: "TikTok", color: "#FF3B5C", views: "12.4K" },
  { day: 1, slot: 1, platform: "Shorts", color: "#FF4E45", views: "8.1K" },
  { day: 1, slot: 2, platform: "Reels", color: "#E1306C", views: "21K" },
  { day: 2, slot: 0, platform: "LinkedIn", color: "#4C8DF6", views: "3.2K" },
  { day: 3, slot: 2, platform: "TikTok", color: "#FF3B5C", views: "46K" },
  { day: 4, slot: 1, platform: "X", color: "#E9EBEE", views: "5.6K" },
  { day: 5, slot: 0, platform: "Reels", color: "#E1306C", views: "9.9K" },
  { day: 6, slot: 2, platform: "Shorts", color: "#FF4E45", views: "17K" },
] as const;
export const CAL = { x: 96, y: 150, colW: 84, rowH: 150, headH: 40 } as const;
export function publishState(t: number) {
  const slide = ramp(t, 6.7, 7.5, ease.inOut); // week slides out, empty week slides in
  const nowX = lerp(CAL.x - 10, CAL.x + CAL.colW * 7 + 10, ramp(t, 3.3, 6.4, ease.inOut));
  const posts = POSTS.map((p, n) => {
    const drop = ramp(t, 0.35 + n * 0.3, 0.8 + n * 0.3, ease.outBack);
    const cx = CAL.x + CAL.colW * p.day + CAL.colW / 2;
    const live = nowX > cx ? ramp(nowX, cx, cx + 40, ease.out) : 0;
    const liveAge = nowX > cx ? (nowX - cx) / 120 : 0;
    return { ...p, n, drop, live, views: p.views, count: clamp(liveAge), cx };
  });
  const scheduled = posts.filter((p) => p.drop > 0.5).length;
  const liveCount = posts.filter((p) => p.live > 0.5).length;
  return { slide, nowX, nowAlpha: Math.min(ramp(t, 3.1, 3.4), 1 - ramp(t, 6.4, 6.7)), posts, scheduled, liveCount, st: t };
}
