import { describe, expect, test } from "bun:test";

import { buildClipCutPlan, sourceWordToEdited, type ClipWindow, type SourceRange } from "./edit-ranges";
import { detectClipCleanupRanges } from "./clip-cleanup";
import { detectFillerWordRanges, isFillerWord, removableFillerWords } from "./filler-words";
import { detectSilenceRanges, SILENCE_DEFAULT_PAD_SEC, SILENCE_MAX_SPEECHLESS_SLIVER_SEC, silenceLeadInSec } from "./silence-detection";
import type { TranscriptUtterance, TranscriptWord } from "./transcript";

// Seeded property checks: thousands of adversarial transcripts, each checked
// against the invariants every caller relies on.

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPS = 1e-6;
const VOCAB = ["so", "we", "the", "Um,", "uh", "erm.", "ER", "UM", "build", "people", "uh-huh", "a"];

function randomCase(seed: number) {
  const r = rng(seed);
  const utterances: TranscriptUtterance[] = [];
  const speakers = 1 + Math.floor(r() * 3);
  for (let s = 0; s < speakers; s++) {
    let t = r() * 3;
    const words: TranscriptWord[] = [];
    const count = Math.floor(r() * 40);
    for (let i = 0; i < count; i++) {
      t += r() < 0.25 ? 0.6 + r() * 3 : r() * 0.3; // pauses of all lengths
      const zero = r() < 0.05;
      const length = zero ? 0 : 0.03 + r() * 0.6;
      words.push({ word: VOCAB[Math.floor(r() * VOCAB.length)]!, startSec: +t.toFixed(3), endSec: +(t + length).toFixed(3), confidence: null });
      t += length;
    }
    if (words.length === 0 && r() < 0.5) continue;
    utterances.push({ index: s, speaker: s, speakerLabel: `Speaker ${s + 1}`, startSec: words[0]?.startSec ?? 0, endSec: words.at(-1)?.endSec ?? 0,
      text: words.map((w) => w.word).join(" ") || "x", confidence: null, words });
  }
  const all = utterances.flatMap((u) => u.words);
  const end = Math.max(5, ...all.map((w) => w.endSec)) + r() * 3;
  const start = r() < 0.5 ? 0 : r() * 4; // windows that start mid-transcript
  const window: ClipWindow = { startSec: +start.toFixed(3), endSec: +(start + Math.max(1, (end - start) * (0.4 + r() * 0.8))).toFixed(3) };
  const quietRanges: SourceRange[] = [];
  for (let q = r() * 2; q < end + 2; ) {
    const len = 0.05 + r() * 4;
    if (r() < 0.6) quietRanges.push({ startSec: +q.toFixed(2), endSec: +(q + len).toFixed(2) });
    q += len + r() * 2;
  }
  const existingDeleted = r() < 0.3 ? [{ startSec: window.startSec + r(), endSec: window.startSec + 1 + r() * 2 }] : [];
  return { utterances, window, quietRanges, existingDeleted };
}

function wellFormed(cuts: SourceRange[], window: ClipWindow) {
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]!;
    expect(cut.endSec).toBeGreaterThan(cut.startSec);
    expect(cut.startSec).toBeGreaterThanOrEqual(window.startSec - EPS);
    expect(cut.endSec).toBeLessThanOrEqual(window.endSec + EPS);
    if (i > 0) expect(cut.startSec).toBeGreaterThan(cuts[i - 1]!.endSec - EPS);
  }
}

function overlapsWord(cut: SourceRange, word: TranscriptWord) {
  if (word.endSec > word.startSec) return cut.startSec < word.endSec - EPS && cut.endSec > word.startSec + EPS;
  return cut.startSec < word.startSec - EPS && cut.endSec > word.startSec + EPS; // a single-instant word strictly inside a cut
}

function outsideQuiet(cut: SourceRange, quiet: SourceRange[]) {
  let covered = 0;
  for (const q of quiet) covered += Math.max(0, Math.min(cut.endSec, q.endSec) - Math.max(cut.startSec, q.startSec));
  return cut.endSec - cut.startSec - covered;
}

const CASES = 3_000;

describe("clip cleanup properties", () => {
  test("silence cuts never touch a word, keep their padding, and stay in quiet audio", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { utterances, window, quietRanges } = randomCase(seed);
      const words = utterances.flatMap((u) => u.words);
      const cuts = detectSilenceRanges(utterances, window, { quietRanges });
      try {
        wellFormed(cuts, window);
        for (const cut of cuts) {
          for (const word of words) {
            expect(overlapsWord(cut, word)).toBe(false);
            // Padding beside speech (inside the window; clip edges are never padded).
            if (word.endSec > word.startSec && word.endSec <= cut.startSec + EPS && word.endSec > window.startSec)
              expect(cut.startSec - word.endSec).toBeGreaterThanOrEqual(SILENCE_DEFAULT_PAD_SEC - 2e-3);
            if (word.endSec > word.startSec && word.startSec >= cut.endSec - EPS && word.startSec < window.endSec)
              expect(word.startSec - cut.endSec).toBeGreaterThanOrEqual(silenceLeadInSec(SILENCE_DEFAULT_PAD_SEC) - 2e-3);
          }
        }
        // Only joined speechless blips may lie outside quiet audio: under 0.3 s in total per cut.
        for (const cut of cuts) expect(outsideQuiet(cut, quietRanges)).toBeLessThan(SILENCE_MAX_SPEECHLESS_SLIVER_SEC + 2e-3);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
    }
  });

  test("Studio mode never re-cuts an existing deletion and is deterministic", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { utterances, window, quietRanges, existingDeleted } = randomCase(seed);
      const options = { quietRanges, existingDeleted, padSec: 0.1, minSilenceSec: 0.5 };
      const cuts = detectSilenceRanges(utterances, window, options);
      wellFormed(cuts, window);
      // Edges are rounded to whole milliseconds, so allow that much contact.
      for (const cut of cuts) for (const del of existingDeleted) expect(cut.startSec < del.endSec - 1e-3 && cut.endSec > del.startSec + 1e-3).toBe(false);
      expect(detectSilenceRanges(utterances, window, options)).toEqual(cuts);
    }
  });

  test("combined cleanup never touches a real word, never empties a clip, stays within limits", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { utterances, window, quietRanges } = randomCase(seed);
      const words = utterances.flatMap((u) => u.words).filter((w) => !isFillerWord(w, "en"));
      for (const quiet of [quietRanges, null]) {
        const cuts = detectClipCleanupRanges(utterances, window, { removeSilences: true, removeFillerWords: true, quietRanges: quiet, languageCode: "en" });
        try {
          wellFormed(cuts, window);
          expect(cuts.length).toBeLessThanOrEqual(500);
          for (const cut of cuts) for (const word of words) expect(overlapsWord(cut, word)).toBe(false);
          if (cuts.length > 0) expect(buildClipCutPlan(cuts, window).isEmpty).toBe(false);
        } catch (error) {
          throw new Error(`seed ${seed} (quiet ${quiet ? "measured" : "null"}): ${(error as Error).message}`);
        }
      }
    }
  });

  test("every word that stays survives the render, and kept fillers are never partly cut", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { utterances, window, quietRanges } = randomCase(seed);
      const all = utterances.flatMap((u) => u.words);
      const removable = removableFillerWords(utterances, window, "en");
      for (const quiet of [quietRanges, null]) {
        const cuts = detectClipCleanupRanges(utterances, window, { removeSilences: true, removeFillerWords: true, quietRanges: quiet, languageCode: "en" });
        const map = buildClipCutPlan(cuts, window).map;
        for (const word of all) {
          const from = Math.max(word.startSec, window.startSec), to = Math.min(word.endSec, window.endSec);
          // A word with under 10 ms inside the clip window is effectively outside it.
          if (to < from || (word.endSec > word.startSec && to - from < 0.01)) continue;
          if (word.endSec <= word.startSec && (word.startSec <= window.startSec + 0.01 || word.startSec >= window.endSec - 0.01)) continue;
          const partly = cuts.some((c) => c.startSec < to - 1e-3 && c.endSec > from + 1e-3);
          const fully = cuts.some((c) => c.startSec <= from + 1e-3 && c.endSec >= to - 1e-3);
          if (removable.has(word)) {
            // A removed filler may be trimmed back only by the render-protection margin.
            if (partly && !fully) {
              const covered = cuts.reduce((sum, c) => sum + Math.max(0, Math.min(c.endSec, to) - Math.max(c.startSec, from)), 0);
              if (to - from - covered > 0.11) throw new Error(`seed ${seed}: filler ${word.word}@${word.startSec} left ${(to - from - covered).toFixed(3)}s`);
            }
            continue;
          }
          if (partly) throw new Error(`seed ${seed}: kept word ${word.word}@${word.startSec}-${word.endSec} partly cut`);
          if (sourceWordToEdited(map, { startSec: from, endSec: Math.max(from, to) }) === null)
            throw new Error(`seed ${seed} (quiet ${quiet ? "measured" : "null"}): word ${word.word}@${word.startSec}-${word.endSec} dropped by the render`);
        }
      }
    }
  });

  test("filler cuts never bridge a silence-length gap between fillers", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { utterances, window } = randomCase(seed);
      const all = utterances.flatMap((u) => u.words).filter((w) => w.endSec > w.startSec).sort((a, b) => a.startSec - b.startSec);
      for (const cut of detectFillerWordRanges(utterances, window, { languageCode: "en" })) {
        const inside = all.filter((w) => w.startSec < cut.endSec && w.endSec > cut.startSec).map((w) => [w.startSec, w.endSec] as const);
        // Inside one filler cut, consecutive fillers are always closer than a silence.
        for (let i = 1; i < inside.length; i++) if (inside[i]![0] - Math.max(...inside.slice(0, i).map((x) => x[1])) >= 1 - 1e-6)
          throw new Error(`seed ${seed}: filler cut ${cut.startSec}-${cut.endSec} bridges a ${(inside[i]![0] - inside[i - 1]![1]).toFixed(2)}s gap`);
      }
    }
  });


  test("every timed filler inside the window is removed unless a word that stays overlaps it", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const { utterances, window } = randomCase(seed);
      const all = utterances.flatMap((u) => u.words);
      const cuts = detectClipCleanupRanges(utterances, window, { removeSilences: false, removeFillerWords: true, quietRanges: null, languageCode: "en" });
      if (cuts.length === 0) continue; // dropped wholesale only when the clip would empty
      // Removed: covered, except the up-to-0.11 s a cut gives back so a neighbouring word survives the render.
      const removed = (w: TranscriptWord) => {
        const covered = cuts.reduce((sum, c) => sum + Math.max(0, Math.min(c.endSec, w.endSec) - Math.max(c.startSec, w.startSec)), 0);
        return covered > 0 && w.endSec - w.startSec - covered <= 0.11;
      };
      for (const filler of all.filter((w) => isFillerWord(w, "en") && w.endSec > w.startSec && w.startSec >= window.startSec && w.endSec <= window.endSec)) {
        // A word stays unless it is a cut filler; a single-instant word protects [t, t + 10 ms].
        const blocked = all.some((w) => w !== filler && !(isFillerWord(w, "en") && w.endSec > w.startSec && removed(w)) &&
          w.startSec < filler.endSec && Math.max(w.endSec, w.startSec + 0.01) > filler.startSec);
        if (blocked || removed(filler)) continue;
        // The only other reason to keep it: cutting it fully would leave a word in a piece the render drops.
        const withFiller = buildClipCutPlan([...cuts, { startSec: filler.startSec, endSec: filler.endSec }].sort((a, b) => a.startSec - b.startSec)
          .reduce<SourceRange[]>((out, c) => { const last = out.at(-1); if (last && c.startSec <= last.endSec) last.endSec = Math.max(last.endSec, c.endSec); else out.push({ ...c }); return out; }, []), window);
        const starved = all.some((w) => w !== filler && !(isFillerWord(w, "en") && removed(w)) && w.endSec > window.startSec && w.startSec < window.endSec &&
          sourceWordToEdited(withFiller.map, { startSec: Math.max(w.startSec, window.startSec), endSec: Math.min(Math.max(w.endSec, w.startSec), window.endSec) }) === null);
        if (!starved) throw new Error(`seed ${seed}: filler ${filler.word}@${filler.startSec}-${filler.endSec} kept`);
      }
    }
  });

});
