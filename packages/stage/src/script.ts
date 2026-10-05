/*
 * The podcast excerpt every video "plays": word timings, speakers, caption
 * cues (3 words, DEFAULT_CAPTION_WORDS_PER_CUE), speech envelopes and the reframe focus.
 * Times are seconds of script time; renderers map their clock onto it.
 */
import { DEFAULT_CAPTION_WORDS_PER_CUE, formatCaptionWord } from "@narriflow/validators";
import { clamp, ease, lerp, ramp } from "./math";

export type Line = { speaker: 0 | 1; text: string };
export type Word = { text: string; start: number; end: number; speaker: 0 | 1; line: number };
export type Cue = { words: Word[]; start: number; end: number; speaker: 0 | 1 };
export type Script = { words: Word[]; cues: Cue[]; duration: number };

/**
 * Time a script at a natural talking pace. With `loop`, the duration is fixed
 * (and must fit the speech) so loops wrap in silence; otherwise it ends with
 * a short pause after the last word.
 */
export function buildScript(lines: Line[], loop?: number): Script {
  const words: Word[] = [];
  let t = 0.2;
  lines.forEach((line, li) => {
    const parts = line.text.split(/\s+/).filter(Boolean);
    parts.forEach((text, wi) => {
      const letters = text.replace(/[^\p{L}\p{N}]/gu, "").length;
      const dur = clamp(0.12 + letters * 0.032, 0.18, 0.42);
      words.push({ text, start: t, end: t + dur, speaker: line.speaker, line: li });
      t += dur + 0.03;
      if (/[.,!?]$/.test(text) && wi < parts.length - 1) t += 0.14;
    });
    t += 0.34;
  });
  const cues: Cue[] = [];
  lines.forEach((_, li) => {
    // Group each utterance into the same fixed-size cues used by preview and export.
    let chunk: Word[] = [];
    const flush = () => {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      if (first && last) cues.push({ words: chunk, start: first.start, end: last.end, speaker: first.speaker });
      chunk = [];
    };
    for (const w of words.filter((x) => x.line === li)) {
      chunk.push(w);
      if (chunk.length === DEFAULT_CAPTION_WORDS_PER_CUE) flush();
    }
    flush();
  });
  const lastEnd = words[words.length - 1]?.end ?? 0;
  if (loop === undefined) return { words, cues, duration: lastEnd + 0.6 };
  if (lastEnd + 0.25 > loop) throw new Error(`script speech ends at ${lastEnd.toFixed(2)}s; loop is ${loop}s`);
  return { words, cues, duration: loop };
}

// Padded to a fixed 7.5 s so 7.5 s and 15 s loops wrap in silence.
export const SCRIPT = buildScript(
  [
    { speaker: 0, text: "Nobody watches the whole forty minute episode." },
    { speaker: 1, text: "They watch the one minute that hits." },
    { speaker: 0, text: "So find it, caption it, ship it." },
  ],
  7.5,
);
export const SCRIPT_DURATION = SCRIPT.duration;

/** Source-frame x of each host in the 1920×1080 podcast set. */
export const HOST_X = [640, 1280] as const;
export const HOST_FACE_Y = 520;

export function cueAt(st: number, script: Script = SCRIPT): { cue: Cue; active: number; enter: number } | null {
  if (st < 0 || st >= script.duration) return null;
  const { cues } = script;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    if (st >= c.start && st < c.end) {
      let active = -1;
      c.words.forEach((w, wi) => {
        if (st >= w.start) active = wi;
      });
      return { cue: c, active, enter: st - c.start };
    }
  }
  return null;
}

/** 0..1 syllable-ish loudness for a speaker right now. */
export function speechLevel(st: number, speaker: number, script: Script = SCRIPT) {
  for (const w of script.words) {
    if (w.speaker !== speaker || st < w.start || st > w.end) continue;
    const p = (st - w.start) / (w.end - w.start);
    const syll = Math.max(1, Math.round(w.text.length / 3));
    return 0.45 + 0.55 * Math.abs(Math.sin(Math.PI * p * syll));
  }
  return 0;
}

/** Smooth 0..1 "this host is talking" state (eases in/out around words). */
export function activity(st: number, speaker: number, script: Script = SCRIPT) {
  let a = 0;
  for (const w of script.words) {
    if (w.speaker !== speaker) continue;
    const v = Math.min(ramp(st, w.start - 0.3, w.start, ease.out), 1 - ramp(st, w.end + 0.1, w.end + 0.6, ease.inOut));
    a = Math.max(a, v);
  }
  return a;
}

/**
 * Reframe focus x in source pixels: glides to whoever is talking, the way
 * speaker-aware auto-layout re-centres the 9:16 crop.
 */
export function focusX(st: number, lead = 0.15, glide = 0.55, script: Script = SCRIPT) {
  const firsts = script.words.filter((w, i, all) => i === 0 || all[i - 1]!.line !== w.line);
  let x: number = HOST_X[firsts[0]?.speaker ?? 0];
  for (const first of firsts) {
    x = lerp(x, HOST_X[first.speaker], ramp(st, first.start - lead - glide, first.start - lead, ease.inOut));
  }
  return x;
}

export function speakerAt(st: number, script: Script = SCRIPT): 0 | 1 {
  let s: 0 | 1 = script.words[0]?.speaker ?? 0;
  for (const w of script.words) if (st >= w.start - 0.2) s = w.speaker;
  return s;
}

export function formatWord(text: string, transform: "uppercase" | "capitalize" | "none" | "lowercase", punctuation = true) {
  const bare = formatCaptionWord(text, { punctuation });
  if (transform === "uppercase") return bare.toUpperCase();
  if (transform === "lowercase") return bare.toLowerCase();
  if (transform === "capitalize") return bare.charAt(0).toUpperCase() + bare.slice(1);
  return bare;
}
