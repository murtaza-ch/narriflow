// Throwaway look proof (ticket 02). Shared by build.ts (HarfBuzz measurement,
// ASS painter) and headline.html (Canvas measurement, DOM painter), so both
// place every word at the same canvas coordinates (spec 5.6, decision 2).
// Plain JS on purpose: Bun imports it and the browser loads it unbundled.
// Not engine code: ticket 03a owns the real `caption-block.ts`.

export const CANVAS = { width: 1080, height: 1920 };
export const ANCHOR = { xPct: 50, yPct: 60 };

/** Headline, spec section 6 (adopted recipe, phase 2 gradient). Minor words draw at body size. */
export const HEADLINE = {
  S: 80,
  roles: {
    minor: { font: "text", sizeEm: 1, letterSpacingEm: 0 },
    body: { font: "text", sizeEm: 1, letterSpacingEm: 0 },
    hero: { font: "hero", sizeEm: 1, letterSpacingEm: -0.03 },
  },
  heroFill: { widthFraction: 0.8, minEm: 2.2, maxEm: 3.4 },
  rowGapEm: 0.06,
  staggerEm: 0,
  gradient: { top: "#A5EBC5", bottom: "#36B780" },
  shadow: { color: "#000000", opacity: 0.65, blurPx: 6, offsetYPx: 2 },
};

/** Stand-in for the future `CAPTION_BLOCK.wordGapEm`: Inter SemiBold's space advance. */
export const WORD_GAP_EM = 0.232;
/** `CAPTION_FIT_WIDTH_FRACTION` in packages/validators/src/caption-style.ts. */
export const FIT_WIDTH_FRACTION = 0.88;
export const SAFE = { left: 0.06, right: 0.94, top: 0.1, bottom: 0.82 };

/** Spec 5.7 `slide`, ms and em. */
export const SLIDE = {
  word: { offsetXEm: -0.18, travelMs: 90, opacityMs: 40 },
  hero: { offsetYEm: 0.12, travelMs: 150, blurEm: 0.04, blurMs: 100, opacityMs: 40 },
};
/** libass power curve for ease "out" (`CAPTION_EASE_ACCEL.out`). */
export const EASE_OUT_ACCEL = 0.5;

export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stack rows: lead (before the hero), hero, tail (after), empty rows dropped. */
export function blockRows(roles) {
  const first = roles.indexOf("hero");
  if (first < 0) return [roles.map((_, index) => index)];
  const last = roles.lastIndexOf("hero");
  const all = roles.map((_, index) => index);
  return [all.slice(0, first), all.slice(first, last + 1), all.slice(last + 1)].filter((row) => row.length > 0);
}

/**
 * Entrance time scale (spec 5.7 duration cap): 0 means "appear settled".
 * `remainingMs` is from the word's onset to the cue's visible end.
 */
export function entranceScale(remainingMs, entranceMs) {
  if (remainingMs < 100) return 0;
  return Math.min(1, (0.45 * remainingMs) / entranceMs);
}

/**
 * cue: { words: [{ text, role, startSec }], endSec, seed }
 * measure(text, font, letterSpacingEm): { advanceEm, inkTopEm, inkBottomEm } at 1 em, the advance
 * including the letter spacing between clusters and excluding the trailing one (spec 5.6).
 * Returns placed words in canvas px plus the block bounds.
 */
export function layoutCue(cue, measure) {
  const style = HEADLINE;
  const S = style.S;
  const roles = cue.words.map((word) => word.role);
  const rows = blockRows(roles);
  const measured = cue.words.map((word) => measure(word.text, style.roles[word.role].font, style.roles[word.role].letterSpacingEm));
  const px = cue.words.map((word) => S * style.roles[word.role].sizeEm);

  const rowWidth = (row, sizes) =>
    row.reduce((total, index, at) => total + measured[index].advanceEm * sizes[index] + (at > 0 ? WORD_GAP_EM * Math.max(sizes[row[at - 1]], sizes[index]) : 0), 0);

  // Rule 3, hero fill: the hero row's width is widthFraction of the frame.
  const heroRow = rows.find((row) => roles[row[0]] === "hero");
  if (heroRow && style.heroFill) {
    const perEm = rowWidth(heroRow, Object.fromEntries(heroRow.map((index) => [index, 1])));
    const target = (style.heroFill.widthFraction * CANVAS.width) / perEm;
    const hero = Math.min(S * style.heroFill.maxEm, Math.max(S * style.heroFill.minEm, target));
    for (const index of heroRow) px[index] = hero;
  }

  // Rule 7, fit: one block scale so the widest row stays inside the fit width.
  const widest = Math.max(...rows.map((row) => rowWidth(row, px)));
  const scale = Math.min(1, (FIT_WIDTH_FRACTION * CANVAS.width) / widest);
  for (let index = 0; index < px.length; index++) px[index] *= scale;

  // Rule 6, signs: alternate across non-hero rows from the seed.
  const baseSign = cue.seed % 2 === 0 ? 1 : -1;
  let nextSign = baseSign;
  const rowSign = rows.map((row) => {
    if (roles[row[0]] === "hero") return baseSign;
    const sign = nextSign;
    nextSign = -nextSign;
    return sign;
  });

  // Rule 4, row pitch from measured ink.
  const inkTop = (row) => Math.max(...row.map((index) => measured[index].inkTopEm * px[index]));
  const inkBottom = (row) => Math.max(...row.map((index) => measured[index].inkBottomEm * px[index]));
  const baselines = [0];
  for (let k = 1; k < rows.length; k++) {
    baselines.push(baselines[k - 1] + inkBottom(rows[k - 1]) + style.rowGapEm * S * scale + inkTop(rows[k]));
  }

  // Rule 5, centred rows (advance boxes), relative to the block axis x = 0.
  const placed = [];
  rows.forEach((row, k) => {
    const width = rowWidth(row, px);
    let cursor = -width / 2 + style.staggerEm * S * rowSign[k] * (roles[row[0]] === "hero" ? 0 : 1);
    row.forEach((index, at) => {
      if (at > 0) cursor += WORD_GAP_EM * Math.max(px[row[at - 1]], px[index]);
      const advance = measured[index].advanceEm * px[index];
      placed[index] = {
        text: cue.words[index].text,
        role: roles[index],
        font: style.roles[roles[index]].font,
        letterSpacingEm: style.roles[roles[index]].letterSpacingEm,
        px: px[index],
        row: k,
        baselineX: cursor,
        baselineY: baselines[k],
        advance,
        inkTop: measured[index].inkTopEm * px[index],
        inkBottom: measured[index].inkBottomEm * px[index],
        motionSign: rowSign[k],
      };
      cursor += advance;
    });
  });

  // Ink box (vertical) and advance box (horizontal), including entrance travel (5.7 reserved space).
  const box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  const rest = { top: Infinity, bottom: -Infinity };
  for (const word of placed) {
    const travelX = word.role === "hero" ? 0 : Math.abs(SLIDE.word.offsetXEm) * word.px;
    const travelY = word.role === "hero" ? SLIDE.hero.offsetYEm * word.px : 0;
    box.left = Math.min(box.left, word.baselineX - (word.motionSign > 0 ? travelX : 0));
    box.right = Math.max(box.right, word.baselineX + word.advance + (word.motionSign < 0 ? travelX : 0));
    box.top = Math.min(box.top, word.baselineY - word.inkTop);
    box.bottom = Math.max(box.bottom, word.baselineY + word.inkBottom + travelY);
    rest.top = Math.min(rest.top, word.baselineY - word.inkTop);
    rest.bottom = Math.max(rest.bottom, word.baselineY + word.inkBottom);
  }

  // Rule 8, anchor: rest ink-box centre on the anchor. Rule 9, safe-area shift.
  let dx = (ANCHOR.xPct / 100) * CANVAS.width;
  let dy = (ANCHOR.yPct / 100) * CANVAS.height - (rest.top + rest.bottom) / 2;
  const clampShift = (low, high, min, max) => (low < min ? min - low : high > max ? max - high : 0);
  dx += clampShift(box.left + dx, box.right + dx, SAFE.left * CANVAS.width, SAFE.right * CANVAS.width);
  dy += clampShift(box.top + dy, box.bottom + dy, SAFE.top * CANVAS.height, SAFE.bottom * CANVAS.height);

  const words = placed.map((word) => ({
    ...word,
    baselineX: word.baselineX + dx,
    baselineY: word.baselineY + dy,
    centerX: word.baselineX + dx + word.advance / 2,
    startSec: cue.words[placed.indexOf(word)].startSec,
  }));
  return {
    scale,
    rows,
    words,
    bounds: { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy },
    inkGaps: rows.slice(1).map((_row, at) => {
      const upper = words.filter((word) => word.row === at);
      const lower = words.filter((word) => word.row === at + 1);
      return Math.min(...lower.map((word) => word.baselineY - word.inkTop)) - Math.max(...upper.map((word) => word.baselineY + word.inkBottom));
    }),
  };
}

/**
 * Pose of one word at `tMs` after its onset, the same numbers the ASS tags
 * encode: linear `\move`, linear `\fade`, `\t` blur with the power curve.
 */
export function wordPose(word, tMs, remainingMs) {
  const hero = word.role === "hero";
  const spec = hero ? SLIDE.hero : SLIDE.word;
  const k = entranceScale(remainingMs, hero ? SLIDE.hero.travelMs : SLIDE.word.travelMs);
  const progress = (durationMs) => (k === 0 ? 1 : Math.min(1, Math.max(0, tMs / (durationMs * k))));
  const travel = 1 - progress(spec.travelMs);
  return {
    dx: hero ? 0 : SLIDE.word.offsetXEm * word.px * word.motionSign * travel,
    dy: hero ? SLIDE.hero.offsetYEm * word.px * travel : 0,
    blur: hero ? SLIDE.hero.blurEm * word.px * (1 - progress(SLIDE.hero.blurMs) ** EASE_OUT_ACCEL) : 0,
    opacity: progress(spec.opacityMs),
  };
}
