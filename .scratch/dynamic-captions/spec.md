# Dynamic captions

**Status:** accepted by the owner (2026-11-19) with the decisions in section 13. One
release: everything in this file ships together, including curved text and text behind the
speaker. "Phase" below only orders the work.

**Readers:** Opus implements from this file. Sol reviews the visuals and the code against
it. Reference images are in `references/`. Section 10 is the build order, section 11 the
review protocol, section 12 the review history.

**Depends on:** sentence-timed dubbing, landed in `c4516cf3`. Its `captionOverride` path
must get roles and blocks like the transcript path (automatic roles only, no Word Keys).

## 1. Problem

Every Narriflow caption preset is one line in one font and one size. Only the active word
changes, by colour, pill or entrance (`packages/validators/src/caption-preset.ts`,
`references/00-current-presets-*.jpg`).

What people post on Instagram and TikTok now looks designed: one word per phrase is large,
the words around it are small, fonts are mixed (heavy sans against italic serif), rows are
stacked tight, and small drawn details finish it. See `references/01` to `14`.

The owner asked three questions:

1. Can the current render system produce these looks?
2. Should Narriflow pick emphasis and layout by itself, or expose a control panel per
   template as Kalakar does?
3. Can it run with no AI cost, or a very small one?

## 2. Answers

**Can the system do it?** Yes for most looks, without a renderer swap. libass can switch
fonts and sizes, place and rotate each event, draw vector shapes and animate scale, blur,
position and rectangular clips. Narriflow already measures words with HarfBuzz in the
worker and mirrors every layer in the Studio. The gap is the data model: nothing says
"this word is the hero" or "this cue is a block of rows". Each renderer needs a painter that
places words at shared coordinates. Neither needs replacing.

| Look | Reference | Verdict | Phase |
| --- | --- | --- | --- |
| Small row, huge hero, small row | 01, 08 | Works | 1 |
| Mixed fonts and sizes in one cue | 01, 06 | Works | 1 |
| Per-word tiles with alternating tilt | 05 | Works | 1 |
| Left-aligned stack beside the speaker | 04, 07 | Works | 1 |
| Serif caps with a display hero | 03 | Works, needs 2 new fonts | 2 |
| Gradient hero | 01 | Works with limits (5.10) | 2 |
| Squiggle underline, stars | 04, 08 | Works | 2 |
| Text on a curve | 14 | Works per glyph, simple scripts only (5.11) | 3 |
| Big word behind the speaker | 12, 13 | Needs a person matte (5.12) | 4 |
| Two emphasised words in one cue | 04 | Not in this plan. One hero (or one 2-word hero) per cue | Out |
| Scattered words around the face, title cards | 06, 09, 11 | Not captions | Out |

**Intelligent or control-heavy?** Intelligent by default, with few controls. A dynamic style
is one click: Narriflow picks the hero, builds the rows, fits the sizes and varies the
layout per cue. The user picks the style, size, position and colours, and can change or
remove the hero of any cue. Fonts and effects sit under Advanced. There is no per-template
panel and no template builder. Kalakar is a caption design tool with 15 to 25 fields per
template. Narriflow applies one style to many clips, so the defaults carry the result.

**AI cost?** Zero. The hero comes from a deterministic scorer over the transcript words,
timings and language. It runs inside the composition plan in the browser and the worker,
and stores nothing except user overrides. Kalakar spends an LLM call per video on the same
decision (`apps/video-worker/src/processor/transcription.ts:595` in the Kalakar repo).

When the scorer is unsure it gives the cue no hero, because a wrong hero looks worse than
none (5.3, confidence gate). If the blind review (gate G1) fails after one tuning round,
the owner has approved a small paid rider on the clip selection call (5.13, about $0.0004
per project). It is built only if G1 fails.

## 3. What exists today

- One `CaptionPreset` per clip document, sizes in canvas px on a 1080-wide frame.
- Cues are built once in `captionLayersForTarget`
  (`packages/composition-plan/src/clip-composition-plan.ts`) with `groupCaptionTokens`
  (`packages/validators/src/caption-cues.ts`). Burn-in, subtitle files and the Studio
  overlay read those layers.
- The look spec is `packages/validators/src/caption-style.ts`. The worker writes ASS
  (`apps/media/src/caption-ass.ts`). The Studio paints DOM with framer-motion
  (`.../studio/_components/caption-style-engine.tsx`).
- The worker lets libass lay out the whole line, with a real space as the gap, and measures
  word boxes with `layoutCaptionLine` (harfbuzzjs, Node only, one em per line). The Studio
  uses inline DOM flow and integer `offsetWidth`. They agree on ink within 0.01 em
  (`apps/media/src/caption-studio-parity.test.ts`, which fakes Canvas with HarfBuzz ink).
  Nothing checks DOM word positions against libass.
- An active word's entrance lives only inside its own segment. The worker's overlay event
  ends at the next word's start (`caption-ass.ts` overlay events, `captionWordSegmentEnd`).
  The Studio remounts the word span on `on`/`off`.
- The Captions panel preview has its own cue derivation (`useLiveCaption`,
  `caption-style-engine.tsx:178`, used at `tool-panels/captions-panel.tsx:312`). Preset
  thumbnails have their own sample cue builder (`_shared/caption-preset-preview.tsx`).
- No per-word caption styling, no person matte, no persisted face boxes.
- `transcriptWordSchema` has no id. `autoCensorWordId` hashes utterance index, word index,
  text and times, so a trim changes every id.

## 4. Decisions

1. **Keep both renderers.** Running libass in the browser (JASSUB) would remove the mirror,
   but it needs `caption-ass.ts` and HarfBuzz font loading working in the browser, a canvas
   overlay in place of the DOM one that drag, resize and selection rely on, and an answer
   for 24 live thumbnails with tens of MB of fallback fonts. That is weeks of work and
   dynamic captions do not need it. The real cost of two renderers is each effect written
   twice, which is why this plan keeps effects few.
2. **Shared code places every word. Renderers measure words and paint them where told.**
   Each renderer reports a word's advance and ink. Shared pure code returns each word's
   size, centre, rotation and pivot in canvas px. The worker emits one ASS event per word
   per paint layer at that `\pos`. The Studio positions each word absolutely. Neither
   renderer lays text out across words. This removes any need for libass line layout and
   CSS inline flow to agree about mixed sizes, gaps, baselines or bidi.
3. **A dynamic style is data** in `CAPTION_DYNAMIC_STYLES`, like `CAPTION_MOTIONS`. After
   phase 1 a new style that uses existing effects needs no renderer code.
4. **Emphasis is roles, not styling.** Every word in a block has one role. The style maps
   roles to type. The user overrides which word is the hero, never per-word fonts or sizes.
5. **Classic presets keep their look.** All new data hangs off an optional `block` on the
   caption layer, and the classic ASS painter is unchanged for the same cues. The one
   change classic presets get is phrase-aware cue breaks (5.4, owner decision 2), which
   moves their cue boundaries. Golden fixtures and existing renders may change; the app has
   no production users.
6. **Every word in a block enters once and stays until the cue ends.** Dynamic styles have
   no active-word colour state. That matches the references and makes each word's
   animation one event.
7. **Overrides are keyed by source time** and stored in `studioEdits` (JSON column, no
   migration).
8. **Zero AI cost.**
9. **Not building:** template builder, per-line template picker, canvas jiggle warp,
   scattered layouts, title cards, exit animations, emoji on dynamic styles, uploaded brand
   fonts as the hero font, two independent heroes per cue, GPU segmentation.

## 5. Design

### 5.1 Vocabulary

Add to `GLOSSARY.md` in ticket 03a.

- **Caption Role.** `hero`, `body` or `minor`. The hero is the emphasised word, or 2-word
  unit, of a cue. Minor words are closed-class words (the, of, to, is, ka, ki, hai). Body is
  everything else.
- **Caption Block.** A cue laid out as one to three rows.
- **Dynamic Style.** An entry in `CAPTION_DYNAMIC_STYLES`.
- **Word Key.** A word's source start time in whole milliseconds, as a string. It survives
  cuts, trims and text corrections. A trim that clamps an edge word's start changes that
  one word's key, which is accepted.

### 5.2 Preset fields

Add to `captionPresetSchema`, optional and scalar so `captionPresetsEqual` and
`matchCaptionPreset` keep working unchanged:

```ts
/** Dynamic Style. Absent = classic single-line caption. */
dynamic: z.enum(CAPTION_DYNAMIC_NAMES).optional(),
/** Built-in face for roles on the hero font slot. Defaults to the style's hero font. */
heroFontName: captionFontNameSchema.optional(),
/** Third colour (tile fill, alternate hero, decorations). Defaults per style. */
accentColor: hexColor.optional(),
/** Multiplies the hero size after fill-to-width. 1 = the style's size. */
emphasisScale: z.number().min(0.7).max(1.4).optional(),
```

When `dynamic` is set, existing fields mean:

- `fontSize` is the body size S. Role sizes are multiples of S. Drag-resize and the size
  slider still change `fontSize`, so they scale the whole block.
- `fontName` and `fontAsset` fill the text font slot. `textTransform` and `letterSpacing`
  apply to roles on the text slot. Hero-slot roles take both from the style.
- `primaryColor` is the body colour, `highlightColor` the hero colour, `accentColor` the
  third colour.
- Outline, shadow and glow apply to every word, scaled by the word's size relative to S.
- `wordsPerCue` is clamped to 2 to 5.
- `animation` must be a motion with `reveal: "word"` and no `effect`. Any other value
  renders as the style's default motion.
- `highlightBoxColor`, `backgroundColor` and `emojis` do nothing. The plan sets every
  word's `emoji` to null for dynamic presets, because `emojis` survives
  `applyCaptionPresetLook` as a placement field.

`heroFontName` uses built-in faces only. Uploaded hero fonts touch at least eight call
sites (brand font contract, studio bootstrap, brand aggregates, render font directory,
glyph planner, caption omissions, template form) and are not needed for phase 1.

### 5.3 Roles (`packages/validators/src/caption-emphasis.ts`, new, pure)

The scorer runs as a second pass over a target's cues, after grouping, because it needs
per-utterance statistics and the previous cue's pick.

```ts
interface CaptionEmphasisWord {
  readonly key: string | null;        // Word Key; null for dub captions
  readonly raw: string;               // transcript text before punctuation stripping and case
  readonly sourceStartSec: number;
  readonly sourceEndSec: number;      // the word's own end, not the next word's start
  readonly utteranceIndex: number;
  readonly utteranceFinal: boolean;
  readonly pauseBeforeSec: number;    // edited-time gap to the previous kept word
  readonly masked: boolean;           // censor caption mask applies
}
assignCaptionRoles(input: {
  cues: readonly (readonly CaptionEmphasisWord[])[];
  language: string | null;
  overrides: Readonly<Record<string, CaptionEmphasisOverride>>;
  policy: "auto" | "never";
}): { roles: CaptionWordRole[]; heroSpan: readonly [number, number] | null }[]
```

**Letters.** Count code points, excluding `\p{M}` marks. No `Intl.Segmenter` or locale API
anywhere in this file (browser and Bun ICU differ).

**Step 1, classify.** Each language has two small hand-written lists (no stopwords-iso, its
English list holds words like "never", "only" and "first").

- `minor`: closed-class words, about 100 to 200 per language (determiners, pronouns,
  auxiliaries, prepositions, conjunctions). Minor words render small and cannot be the
  hero.
- `filler`: discourse words (like, yaar, bhai, basically, matlab, toh). Filler renders as
  body and cannot be the hero.
- Ship lists for English, Urdu (Arabic script), Hindi (Devanagari), and a Roman Urdu and
  Hindi list that applies token by token to Latin tokens when the language is `ur` or `hi`.
  Cap the total at 20 KB, since it ships to the browser.
- Languages with no list: a spaced-script word of 2 letters or fewer is minor.
- Never minor, whatever the lists say: anything with a digit, %, or currency sign, number
  words, negations (not, never, no, nahi, mat, na, نہیں), and power words.

**Step 2, score** every word that can be the hero. Starting weights
(`CAPTION_EMPHASIS_WEIGHTS`); tune only on the tuning half of the G1 sheet.

| Signal | Score |
| --- | --- |
| Number: digit, %, currency, or number word | +2.0 |
| Negation | +1.0 |
| Power word (English list of about 80; others may be empty) | +1.0 |
| Stretch. `ratio = duration / (utterance median seconds-per-letter × clamp(letters, 3, 12))`. Score `clamp(ratio − 1.15, 0, 1) × 1.5`. Uses `sourceEndSec − sourceStartSec` | 0 to +1.5 |
| Pause of 0.25 s or more before it, not first word of its utterance | +1.0 |
| ALL CAPS in the source transcript, 2 letters or more | +1.0 |
| Utterance-final, or followed by sentence punctuation in `raw` | +1.0 |
| Topic word: same normalised word appears 3 or more times in the clip | +0.5 |
| Cue-final | +0.25 |
| Capitalised, not sentence-initial, cased script | +0.25 |
| Length, 0.05 per letter | 0 to +0.5 |
| Same normalised word was the automatic hero of the previous cue | −1.0 |
| Masked | not eligible |

**Step 3, units.** A number followed by a unit or scale word (percent, million, billion,
thousand, k, dollars, rupees, lakh, crore, years, days, hours, minutes, seconds, times,
x) forms a 2-word unit that scores as its number. Two adjacent capitalised,
non-sentence-initial words in a cased script ("New York") form a unit that scores as the
higher of the two. A hero is a single word or one such unit.

**Step 4, pick (confidence gate).** With `policy: "auto"`, the top candidate is the hero
only if its score is at least 1.5 and at least 0.5 above the runner-up. Ties go to the
later word. Otherwise the cue has no hero. With `"never"`, no cue has a hero.

**Step 5, overrides.** `CaptionEmphasisOverride` is `"hero"`, `"pair"` (hero spanning this
word and the next word of the same cue) or `"plain"` (never hero).

- A `"hero"` or `"pair"` override inside a cue wins over the gate and the scores. If a cue
  holds several, the highest-scoring overridden word wins.
- "No emphasis" for a cue writes `"plain"` for every word in it.
- Overrides whose key matches no word are ignored. Nothing cleans them up. Max 2,000
  entries.
- The repeat penalty compares against automatic picks only, so an override in one cue never
  changes the next.

**Untimed utterances** (one caption word holding a whole utterance) get no block and render
as the classic line.

### 5.4 Cue breaks

`groupCaptionTokens(texts, wordsPerCue, softBreakAfter?)` gains an optional third argument.
`softBreakAfter[i]` is true when `raw` of token i ends with sentence or clause punctuation,
or the edited-time gap after it is 0.35 s or more. When adding token i would overflow the
budget and the open cue holds a soft break that leaves at least 2 tokens in the closed cue,
the cue closes after the latest soft break. A soft break never closes a cue that is not
overflowing. Without the argument the function is unchanged. `captionLayersForTarget` passes
it for every preset (owner decision 2).

### 5.5 The block in the plan

```ts
interface CompositionCaptionBlock {
  readonly style: CaptionDynamicName;
  /** Parallel to `words`. */
  readonly roles: readonly CaptionWordRole[];
  /** Display text per word after the role's case transform. Subtitles keep `words[].text`. */
  readonly texts: readonly string[];
  readonly keys: readonly (string | null)[];
  /** Row entries index `words`, in spoken order. */
  readonly rows: readonly (readonly number[])[];
  /** Stable per-cue seed: FNV-1a of the first word's key, else of `cueIndex`. */
  readonly seed: number;
}
interface CompositionCaptionVisualLayer { /* existing fields */ readonly block?: CompositionCaptionBlock }
```

- `words[].text` keeps the preset transform it has today, so SRT, VTT and the clip timeline
  (`clip-timeline.ts`, MCP `narriflow_get_clip_timeline`) are untouched by roles.
- Order for a dynamic preset: censor and punctuation formatting, grouping with soft breaks,
  roles (second pass), role transforms into `texts`, rows.
- Rows come from `captionBlockRows(roles, heroSpan, style)` in validators, without
  measurement. `layout: "stack"` puts the hero alone on its row, the words before it on a
  lead row, the words after on a tail row, dropping empty rows. `layout: "row"` is one row.
  A cue with no hero is one row, every non-minor word drawn at `style.noHeroSizeEm`.
- One shared builder, `captionCueBlock(words, preset, language, cueIndex)`, is used by the
  plan and by the preset thumbnails and brand-kit previews, so samples render through the
  real pipeline.

### 5.6 Geometry (`packages/caption-fonts/src/caption-block.ts`, new, browser-safe subpath)

It lives in `caption-fonts` next to `bidi-order` because it needs `captionWordVisualOrder`.
Export it as `@narriflow/caption-fonts/caption-block`. No `node:` imports.

```ts
interface MeasuredWord {
  readonly advanceEm: number;     // at 1 em, including letter spacing, excluding trailing spacing
  readonly inkTopEm: number;      // above baseline, positive
  readonly inkBottomEm: number;   // below baseline, positive
}
layoutCaptionBlock(input: {
  block: CompositionCaptionBlock; preset: CaptionPreset; style: CaptionDynamicStyle;
  words: readonly CompositionCaptionWord[]; measured: readonly MeasuredWord[];
  canvas: { width: number; height: number }; anchor: { xPct: number; yPct: number };
  direction: "ltr" | "rtl";
}): { scale: number; words: readonly PlacedWord[]; bounds: Rect; decorations: readonly PlacedDecoration[] }
interface PlacedWord {
  readonly px: number;            // font size in canvas px, after fit
  readonly baselineX: number;     // left of the advance box
  readonly baselineY: number;
  readonly centerX: number;       // centre of the advance box at the baseline's ink middle
  readonly centerY: number;
  readonly rotationDeg: number;   // block tilt + tile tilt, clockwise
  readonly motionSign: 1 | -1;    // for direction-flipping motions
}
```

Measurement:

- Worker: `layoutCaptionLine` on each word alone, with the word's face, letter spacing and
  fallback parts. It already returns `widthEm`, `inkTopEm` and `inkBottomEm`.
- Studio: Canvas 2D `measureText` at 100 px after `document.fonts` reports the faces loaded,
  using `width` and `actualBoundingBoxAscent`/`Descent`, the same method as
  `measureCaptionFallbackInkEm` in `apps/web/app/caption-script-fonts.ts`. Fractional
  values, never `offsetWidth`.

Rules, in order:

1. **Sizes.** `px = S × role.sizeEm`. A cue with no hero uses `noHeroSizeEm` for non-minor
   words.
2. **Gap.** Between adjacent words in a row: `CAPTION_BLOCK.wordGapEm × max(px(left), px(right))`,
   or 0 when the right word has `spaceBefore: false`. Tile styles add their padding.
3. **Hero fill.** If the style sets `heroFill`, scale the hero row so its width (advances
   plus gaps plus stroke and tile extent) equals `heroFill.widthFraction × canvas.width`,
   clamping the hero size to `[S × minEm, S × maxEm]`. Then multiply by `emphasisScale`.
4. **Row pitch** from measured ink:
   `baseline[k+1] = baseline[k] + maxInkBottom(row k) + style.rowGapEm × S + maxInkTop(row k+1)`,
   where `maxInkTop` and `maxInkBottom` are the row's largest `ink × px` plus stroke.
   `rowGapEm` may be negative.
5. **Row x.** Rows are centred on the block axis for `align: "center"`. For `align: "left"`
   rows start at the block's left edge, mirrored to the right edge for an RTL cue. Words
   inside a row follow `captionWordVisualOrder`.
6. **Stagger.** Lead and tail rows shift by `style.staggerEm × S × sign`. Row 0 has sign
   `seed % 2 === 0 ? 1 : −1`, the next non-hero row the opposite. The hero row does not
   shift. `motionSign` of every word in a row equals the row's sign.
7. **Fit.** One block scale: `min(1, CAPTION_FIT_WIDTH_FRACTION × canvas.width / widestRow)`,
   applied to every word, so the hierarchy holds. Hero fill already targets less than the
   fit width, so this only bites on long lead or tail rows.
8. **Anchor.** Centre styles put the block's ink-box centre on the anchor. Left styles put
   the block's left edge at `anchor.xPct` and its vertical ink centre at `anchor.yPct`. A
   left style's default `positionX` is `style.leftGuidePct`.
9. **Safe area.** Shift the block (not the stored position) to keep its bounds, including
   decorations and the reserved entrance travel (section 5.7), inside x 6% to 94% and
   y 10% to 82%.
10. **Rotation.** Block tilt (`CAPTION_CUE_TILTS_DEG[seed % 4]` when the motion tilts) turns
    each word's centre about the block centre. `rotationDeg = blockTilt + tileTilt`, where
    `tileTilt = style.tile.tiltsDeg[(wordIndex + seed) % n]`.

Painting:

- **Kerning.** Every ASS script the worker writes sets `Kerning: yes` in `[Script Info]`.
  libass does not kern by default, while HarfBuzz and the browser do; ticket 02 measured a
  10 px drift on "Accurate" without it. This applies to classic presets too, so ticket 03b
  updates the ticket 00 snapshot on purpose and says so in its commit.

- **Worker.** Each word gets one event per paint layer (shadow, outer, glow, text) with
  `\an5\pos(centerX, centerY)\org(centerX, centerY)\frz(−rotationDeg)` plus its motion
  tags. Tiles are `\p1` shapes with the same `\pos` and `\org`. Reuse the per-word
  `eventX`/`anchorY` correction (`caption-ass.ts` overlay placement) so a single-word event's
  baseline lands where the layout says.
- **Studio.** Each word is an absolutely positioned element at the same centre with
  `transform-origin` at that centre. A word's transform is
  `rotate(θ) translate(dx, dy) scale(sx, sy)` (applied right to left), which matches libass:
  `\move` translates in screen space, then `\frz` turns about the fixed `\org`.
- Geometry unavailable (HarfBuzz cannot shape a face): the worker renders the cue as
  today's classic line. The Studio cannot detect this and keeps the block. Accepted
  mismatch, limited to uploaded WOFF2 text-slot fonts.

### 5.7 Motion

- `CaptionKeyframe` gains `offsetXEm` and `rotateZDeg`. `CaptionMotionSpec` gains an
  optional `hero: readonly CaptionKeyframe[]`. Hero words use `hero ?? word`; other words
  use `word`. `offsetXEm` is multiplied by the word's `motionSign`.
- **Timing.** A word's events run from its first spoken time to the cue's visible end.
  Motion tags count from the event start. Unspoken words are not drawn.
- **Duration cap.** Each word's keyframe times are scaled by
  `min(1, 0.45 × remainingCueMs / entranceMs)`. With less than 100 ms of cue left, the word
  appears settled.
- **Reserved space.** Shared geometry adds each word's maximum entrance travel and scale
  growth to `bounds`, so the safe-area shift covers it.
- **libass limits** (`caption-style.test.ts` keeps enforcing them): ease is a power curve;
  position moves through one linear `\move` per event, so x and y travel share one window;
  `\org` stays at the rest centre during travel, and the Studio copies that pivot.
- **Studio playback.** Block cues compute every word's pose from the playhead
  (`timeSec − word.startSec`, sampled with `captionKeyframeValue`) on each frame and write
  transforms imperatively. No mount-triggered animation. Pause, scrub and seeking into an
  entrance show the same pose the export shows at that time.
- **Reduced motion** shows settled words, as classic presets do today.

New motions (ms, values at 1 em):

| Name | `word` | `hero` |
| --- | --- | --- |
| `slide` | x −0.18 em to 0 over 0 to 90, opacity 0 to 1 by 40 | y 0.12 em to 0 over 0 to 150, blur 0.04 em to 0 by 100 (out), opacity 0 to 1 by 40 |
| `slam` | scale 1.08 to 1 by 80 (out), opacity 0 to 1 by 40 | scale 1.25 to 0.98 by 110 (out), to 1 by 160, opacity 0 to 1 by 40 |
| `drop` | y −0.20 em to 0 and rotateZ −4° to 0 over 0 to 120, opacity 0 to 1 by 40 | same |

Existing `rise`, `blur`, `punch`, `bounce`, `flip` and `fade` stay available. `jelly` is
excluded for dynamic styles: 380 ms is longer than most cue windows.

### 5.8 Style table (`packages/validators/src/caption-dynamic.ts`, new)

```ts
type CaptionColourSlot = "primary" | "highlight" | "accent";
interface CaptionRoleType {
  readonly font: "text" | "hero";
  readonly sizeEm: number;
  readonly transform: "inherit" | "uppercase" | "lowercase" | "capitalize" | "none";
  readonly letterSpacing: number | "inherit";
  readonly colour: CaptionColourSlot;
}
interface CaptionDynamicStyle {
  readonly name: string;
  readonly layout: "stack" | "row";
  readonly align: "center" | "left";
  readonly roles: Readonly<Record<CaptionWordRole, CaptionRoleType>>;
  readonly noHeroSizeEm: number;
  readonly heroFontName: CaptionFontName;
  /** Hero colour alternates between these by `seed`. One entry = no alternation. */
  readonly heroColours: readonly CaptionColourSlot[];
  readonly heroFill?: { readonly widthFraction: number; readonly minEm: number; readonly maxEm: number };
  readonly rowGapEm: number;
  readonly staggerEm: number;
  readonly leftGuidePct?: number;
  readonly defaultMotion: CaptionAnimationName;
  readonly tile?: {
    readonly fill: Readonly<Record<CaptionWordRole, CaptionColourSlot | string>>;
    readonly tiltsDeg: readonly number[];
    readonly radiusEm: number; readonly padXEm: number; readonly padYEm: number;
  };
  /** Phase 2 only. */
  readonly gradient?: { readonly top: string; readonly bottom: string };
  readonly decorations?: readonly ("underline" | "stars")[];
}
```

Literal hex strings in `tile.fill` and `gradient` are style constants that the user's
colours do not change. Slots follow the user's colours.

### 5.9 Scripts and direction

- Rows keep bidi visual order per row. Left-aligned styles mirror for RTL.
- A face without the script falls back through the pinned chain. Size and colour hierarchy
  still apply. The serif-against-sans contrast is lost in Nastaliq or Devanagari, which is
  accepted.
- Case transforms are no-ops in uncased scripts.
- Letter-level effects stay off for shaping-sensitive text, as today.

### 5.10 Phase 2 effects

- **Gradient.** Only for styles whose motions neither scale nor rotate the hero. Worker:
  the hero's text layer is split into horizontal `\clip` bands of 8 px or fewer, at most 48 per hero word (and within the 120
  events per cue budget),
  each with an interpolated `\1c`, covering the hero's bounds plus its entrance travel.
  Band edges fall on even pixel rows, or 4:2:0 encoding shows grey seams (ticket 02).
  Studio: `background-clip: text` with the same two colours over the hero's rest box. CSS
  paints `text-shadow` over a clipped gradient, so the shadow is its own element behind the
  word, as the worker's shadow is its own event. At
  rest the two match. During the 150 ms travel they differ by up to the travel distance,
  which is accepted. Shadow, outer stroke and glow are not banded.
- **Underline.** One shared point list in a unit box (`M`, `L`, `C` only), serialised to an
  SVG path and to an ASS `\p1` drawing (`m`, `l`, `b`). Under the hero, 0.12 hero-em below
  the baseline, 0.04 hero-em thick, white, wiped left to right with a rectangular clip over
  120 ms, starting 60 ms after the hero. Only on unrotated words. Its box is reserved in
  row pitch. Dropped when the cue has less than 300 ms left at the hero's start.
- **Stars.** Five-point stars at 0.20 and 0.28 hero-em, at the block's ink corners pushed
  out by 0.3 hero-em, popping 0 to 1.1 to 1 over 120 ms, 40 ms apart, from 60 ms after the
  hero. Same drop rule as the underline.

### 5.11 Curved text (reference 14)

- Preset field `curve: z.number().min(-1).max(1).optional()`. Absent or 0 is straight.
  Positive arches the row (middle higher than the ends), negative bows it. Allowed on
  dynamic styles without tiles. The Studio shows it as a Curve slider under Advanced for
  those styles.
- Geometry, in `caption-block.ts`. A row of width W gets a total sweep
  `θ = curve × CAPTION_CURVE.maxSweepDeg` (70°) and radius `R = W / θ` (radians). A glyph
  cluster whose centre sits at arc length `s` from the row centre goes to angle `φ = s / R`:
  centre `(rowCentreX + R sin φ, baselineY − sign × R (1 − cos φ))`, rotation `φ`. Fish-eye:
  cluster size × `1 − CAPTION_CURVE.edgeShrink × |curve| × (φ / φmax)²`, edgeShrink 0.18.
  Row pitch uses the arc's vertical extent, so curved rows never collide.
- Clusters. A cluster is a base code point plus its following `\p{M}` marks (no
  `Intl.Segmenter`). The worker gets cluster offsets from HarfBuzz (add
  `captionClusterOffsets` next to `layoutCaptionLine` in `packages/caption-fonts/src/shaping.ts`).
  The Studio gets them from Canvas `measureText` of each prefix, which includes kerning.
- Painting. One event (worker) or element (Studio) per cluster per paint layer, same pivot
  rule as 5.6. Words keep their entrance, applied to all of their clusters together:
  opacity, blur and screen-space travel only. Scale and rotation keyframes are dropped on
  curved rows, so curved styles default to `blur`.
- Shaping-sensitive text (Arabic script, Indic, Thai) and no-space scripts keep straight
  rows, because splitting them into clusters breaks joining.
- Budget: 200 events per curved cue. Curved styles carry a shadow and no outline, so each
  cluster is 2 layers.

### 5.12 Behind the speaker (references 12, 13)

- Preset field `heroBehind: z.boolean().optional()`. When true, the hero row of a cue that
  has a hero (the hero, its underline and stars) is drawn behind the person. Everything
  else stays in front. Offered on centre-aligned stack styles, as a toggle under Advanced.
  `block.behind` marks such cues in the plan.
- Matte model: MediaPipe Selfie Segmenter (`selfie_segmenter.tflite`, Apache-2.0), one file
  vendored in `apps/media/models/` and copied to `apps/web/public/models/`. A test checks
  both copies have the same hash. CPU only, no API, no GPU.
- **Plan.** For behind cues the plan adds `mattes: { sourceStartSec, sourceEndSec }[]` to
  the target, in source time, padded 0.2 s each side and merged. The plan stays pure.
- **Worker matte.** `apps/media/python/narriflow_media/person_matte.py` runs the model over
  those ranges at 15 fps on frames downscaled to 256 px, smooths the masks over time
  (exponential, α 0.6), feathers them (1.5 px Gaussian at output size), and writes a
  grayscale video at the source's size. That video is cut and retimed by the same edit
  plan as the source video, so it shares the edited clock.
- **Worker graph.** The matte input goes through the same visual stack as the source, in a
  matte mode of `compileCompositionPlanVideo`: source layers get the matte, every other
  layer (B-roll, inserted scenes, background, logo, text layers) is drawn black. That gives
  a matte that follows crops, two-up tiles and screen layouts, and is zero wherever
  something covers the speaker. The caption stage becomes:
  `scene → split; behind ASS on one copy; alphamerge the other copy with the matte → person;
  overlay person; front ASS; emoji`. `renderCaptionTrack` returns `ass` and `behindAss`.
  Without behind cues the graph is unchanged.
- **Studio.** `@mediapipe/tasks-vision` `ImageSegmenter` with the same model file, in a
  Web Worker, fed preview frames through `requestVideoFrameCallback`, at most 15 fps,
  only while a behind hero is visible. Overlay order: video, behind hero row, a person
  canvas, front captions. The person canvas draws the current frame masked by the result
  (`destination-in`), with the same CSS geometry the preview gives the video element.
- **Typed degradation.** If the matte cannot be made (model load or inference fails), the
  hero renders in front. The worker records the notice `caption_matte_unavailable` on the
  render. The Studio shows a small notice in the Captions panel. A blank or failed matte
  never hides the hero.
- **Gate G3** (inside ticket 09, before the Studio half): on 5 real clips Sol and the owner
  accept the edge quality; render time of a 30 s clip whose every cue has a behind hero is
  at most 1.5 times the same clip without; Studio preview holds 20 fps or better on the
  owner's laptop. If any fails, stop and report before building more.

### 5.13 LLM rider (built only if G1 fails)

- Add `emphasis_words: string[]` (up to 8 per clip, words or 2-word units from the clip's
  own text) to the clip selection response: `CLIP_DETECTION_JSON_SCHEMA` in
  `packages/services/src/clip-selection-policy.ts`, `clipDetectionLlmResponseSchema` in
  `packages/validators/src/clip.ts`, and the prompt. The response schema hash changes, so
  the frozen selection contract (`clip-selection-control.ts`, `execution-selection-restore.ts`)
  is reviewed as a critical path.
- Persist on the clip as `Clip.emphasisWords Json?` (one migration).
- The scorer adds +3.0 to a word or unit whose normalised text matches. Existing clips have
  none and use the scorer alone.
- Cost: output tokens only on a call that already runs, about $0.0004 per project.

## 6. Art direction

Sol reviews against these rules.

1. **One hero per cue,** at least 2.2 times the body size after fit. Tile styles have no
   hero and are exempt.
2. **Approved contrasts only.** Each style is one of: heavy sans hero with medium sans
   support; italic serif with small sans minor words; caps tiles in two colours; display
   hero with serif caps support. Do not combine contrasts outside the style's recipe.
3. **Tight stacking.** Ink-to-ink gap between rows of 0.04 to 0.20 S. Measured, not line
   height.
4. **Colour.** Support words white or cream. One hero colour. No more than two colours plus
   white in a cue.
5. **Legible after fit.** Every word, minor words included, is at least 40 px on a
   1080-wide frame after fit. Styles without an outline carry a soft shadow on every word.
   Check dark, bright and busy frames.
6. **Motion.** Entrances only, full opacity within 40 ms, supporting words 90 ms or less
   and 0.2 em or less of travel, the hero 160 ms or less and the only blur. Stable held
   composition after that. No loops, no shake, no reflow.
7. **Reading order and reserved space.** Rows read in spoken order. Decorations and the
   full entrance stay inside the frame and never overlap another row's ink.
8. **Safe area.** Nothing in the top 10% or below 82%.
9. **Seeded variation.** Variation comes from the block `seed` (the first word's key), so
   cuts elsewhere do not reshuffle a cue's look.

### Phase 1 catalog (no new fonts)

A "Dynamic" group, first in the gallery. Values are starting points for visual review.
Names match the existing one-word style.

| Style | Reference | Layout | Support (minor, body) | Hero | Colours | Motion | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Headline | 01 | stack, centre | Inter SemiBold, sentence case, S = 80, minor same size as body | Inter, mixed case, letter spacing −0.03 em, fill 0.80, 2.2 to 3.4 S | white; hero `#36B780` (flat in phase 1) | `slide` | no outline; shadow black 65%, 6 px blur, 2 px down; rowGap 0.06 |
| Editorial | 06 (foreground type only, an adaptation) | stack, centre | minor Inter SemiBold 40 px, body Instrument Serif 60 px, S = 60 | Instrument Serif, lowercase, 144 px (2.4 S) | all `#F6EFE4`, hero in `highlightColor` default `#F6EFE4` | `blur` | stagger 8 px, rowGap 0.10 |
| Cutout | 05 | row | Bebas Neue caps, S = 84 | none | body tiles `#16161A` with `#F5923E` ink, minor tiles `#F4B6D2` with `#16161A` ink | `drop` | tiles radius 0.05 em, pad 0.12 × 0.08 em, gap 0.08 em; tilts −2, 1.5, −1, 2; hard shadow 3 px; wordsPerCue 5 |
| Marker | 04, 07 (partial: one hero, not two) | stack, left, guide 8% | Poppins, lowercase, S = 48 | Poppins, lowercase, 120 px (2.5 S) | white; hero alternates `#FFD248` and `#EF8DB9` by seed | `rise` | rowGap 0.14; underline in phase 2 |
| Stack | 08 | stack, centre | Inter SemiBold, lowercase, S = 48 | Inter, lowercase, 144 px (3.0 S) | white | `slide` | rowGap 0.04; stars in phase 2 |

Every phase 1 preset sets `wordsPerCue: 4` except Cutout. A style shrinks minor words only
when its catalog row says so (Editorial). Mixed minor and body sizes in one row looked uneven
in the ticket 02 proof, so Headline, Marker and Stack draw minor words at body size.

### Later catalog additions (same release)

- **Groove** (reference 03, phase 2). DM Serif Display caps support at 64 px, Caprasimo
  capitalised hero at 176 px in `#F59ABB`, white support, rowGap 8 px, outline 0, 4 px soft
  shadow, motion `slide`. Both faces are new (OFL, static, licence file, metrics, the
  coverage script, web registration).
- Phase 2 also gives Headline its gradient (`#A5EBC5` at the top to `#36B780` at the
  bottom), Marker its underline and Stack its stars.
- **Arc** (reference 14, phase 3). DM Serif Display, sentence case, all words `#F3E9C6`,
  support S = 64, hero 2.2 S, every row curved at 0.55, soft shadow black 70%, no outline,
  rowGap 0.04, motion `blur`.
- **Depth** (references 12, 13, phase 4). Inter SemiBold support, white, S = 52; Inter hero,
  lowercase, white at 96%, fill 0.92, 3.0 to 5.5 S; `heroBehind: true`; default
  `positionY` 32 so the hero sits behind the head and shoulders; motion `rise`.

Not in this release: reference 11 (script plus heavy caps) and glow (10).

## 7. Studio

- The gallery gets the Dynamic group. Thumbnails call `captionCueBlock` on the sample
  phrase and play it with the playhead-driven painter.
- The Customize tab for a dynamic preset shows: Style (the gallery), Size, Position, Text
  colour, Hero colour (the Highlight control, renamed), Accent colour (only for styles that
  use the accent slot), and Emphasis. Under Advanced: Text font, Hero font, Text transform,
  Animation (word-reveal motions), Words on screen, Emphasis size, Outline, Shadow, Glow.
  Curve (styles without tiles) and Hero behind speaker (centre stack styles) also sit under
  Advanced. Subtitles and Punctuation toggles stay where they are. Emoji, highlight pill and backdrop
  are hidden.
- **Emphasis row.** Chips for the words of the cue under the playhead, hero chip filled.
  - Tap a chip: it becomes the hero (`"hero"`).
  - "Join next" on the hero chip: the hero becomes that word plus the next (`"pair"`).
  - "No emphasis": every word in the cue becomes `"plain"`.
  - "Auto": clears the cue's overrides.
- New undoable action `setCaptionEmphasis(keys, value | null)`, added to
  `editorActionSchema`, the reducer, undo history and the contract test. Storage is
  `studioEdits.captionEmphasis: Record<string, "hero" | "pair" | "plain">`, and the field
  must be added to `studioEditsEqual`, or edits are dropped as no-ops.
- **Drag.** Centre styles drag the block centre, as today. Left styles drag the block's left
  edge (stored as `positionX`). Resize changes `fontSize`. The safe-area shift applies only
  to rendering, so the stored position is what the user set.
- "Apply to all clips" copies the preset. Emphasis overrides are per clip.
- The panel preview and the overlay both read the plan's caption layers. Delete
  `useLiveCaption`'s cue derivation and `getCurrentCaptionState` in ticket 03c.
- **Brand colours** for dynamic presets: support stays the style's white or cream, brand
  primary goes to the hero, brand secondary to the accent
  (`applyBrandColorsToCaption`).

## 8. Cost and performance

- AI: none.
- Events: one per word per layer for the cue's life, roughly 15 to 30 per cue, plus tiles
  and, in phase 2, gradient bands. Budget: 120 events per cue, and the heaviest phase 1 or 2
  look over 20 s at 1080x1920 renders in at most 1.35 times Bold Pop's wall time on the
  same machine. Ticket 02 measured 1.05x locally (M1 Pro, still background, system
  libass). That is a local measurement, not a bound for real footage or the worker image's
  libass build; ticket 03b re-measures on the worker image.
- Person matte (ticket 09): CPU in the render only over behind-hero ranges, plus the
  browser model in the Studio. Measured in G3.
- Studio: the current cue's words are positioned and transformed imperatively each frame.
  Ticket 03c checks playback holds frame rate on the owner's laptop.

## 9. Fixtures (for tests and review)

`packages/composition-plan/src/__fixtures__/dynamic-captions/` holds a committed manifest:
per case the words with keys and timings, language, overrides, preset, expected roles, and
which reference it is compared to. At least: one English cue per style, a cue with a
number unit, a cue the gate leaves without a hero, an Urdu cue, a Japanese cue, a cue
shorter than 300 ms per word, and a 5-word long-hero cue that hits the fit clamp.

- Worker frames: extend `apps/media/scripts/caption-frames.ts` to render full 1080x1920
  frames over three pinned backgrounds (dark, bright, busy, stored in the fixture folder)
  at onset − 1 frame, onset, +33, +100, +200 ms, settled, and cue end − 1 frame, at 30 fps.
  One command renders a case: `bun apps/media/scripts/caption-frames.ts <outDir> <caseId>`.
- Studio frames: extend the existing `apps/web/app/prototype/caption-parity` page to load
  a fixture case by id and seek to a given time. It stays in the repo.
- Real transcripts for the G1 sheet are exported read-only as JSON and stay out of git.

## 10. Build order

Run `bun run lint`, `bun run typecheck` and `bun run test` on every ticket. PostgreSQL gates
and heavy suites stay off (AGENTS.md). No compatibility shims.

**00. Classic snapshot.** Add an ASS snapshot of all 24 classic presets on fixed cues to
`caption-ass.test.ts`. This holds decision 5. Nothing else.

**01. Scorer and blind G1.** `caption-emphasis.ts`, the word lists, unit tests per signal,
the unit rule, the gate and overrides. The pick-sheet script
(`packages/validators/scripts/emphasis-sheet.ts`) reads an exported JSON file and prints
cues without picks for blind labelling, then scores labels against the scorer and against a
baseline ("digits win, else last non-minor word"). Done when G1 is recorded below.

**02. Look proof.** One hand-written ASS file and one static HTML page for Headline with
the phase 2 gradient and the hero blur, burned over a real talking-head frame with the
worker's ffmpeg and fonts. Measure the render budget (section 8) on the heaviest look.
Keep the ASS, HTML and frames in `references/proof/` as baseline artefacts. Can run beside
01. Done when Sol passes G2 and the numbers are recorded.

**03a. Pure core.** Preset fields, style table with Headline, soft breaks, `block` in the
plan, `captionCueBlock`, `caption-block.ts` geometry, new motion fields and `slide`,
`GLOSSARY.md`, the ADR for decisions 1 and 2, unit tests for geometry and rows. Update
`caption-preset.test.ts` for the new group. Blocked by 00, 01, 02.

**03b. Worker painter.** Per-word events from the geometry, per-word measurement, the
fixture cases in `caption-frames.ts`, a real-libass test in the manner of
`caption-pill-render.test.ts` that finds each word's ink where the geometry says. Blocked
by 03a.

**03c. Studio painter.** Absolute per-word painter with playhead-driven poses, Canvas
measurement, the panel preview and thumbnails on the plan and `captionCueBlock`, the
`caption-parity` page cases, the REST snapshot
(`apps/api/src/domains/rest/__snapshots__/app.test.ts.snap`) and the public OpenAPI document
regenerated with `bun run --cwd apps/api openapi:generate` and verified with
`openapi:check`. Blocked by 03a. Can run beside 03b.

**04. Studio controls and emphasis.** Section 7. Blocked by 03c.

**05. Rest of the phase 1 catalog.** Editorial, Cutout (tiles, `drop`, `rotateZDeg`),
Marker (left alignment), Stack, `slam`. MCP preview cards
(`packages/mcp-core/src/mcp-apps/v2`), brand kit forms and previews, brand colour mapping,
a docs page showing the styles. Blocked by 03b, 03c.

**06. Phase 2.** Groove and its two faces, gradient, underline, stars (5.10). Blocked by 05.

**07. Curved text.** 5.11, `captionClusterOffsets`, the Arc style, the Curve slider, fixture
cases and a real-libass test for cluster placement. Blocked by 06 (uses DM Serif Display).

**08. LLM rider.** 5.13. Only if G1 failed after one tuning round. Blocked by 01.

**09. Behind the speaker.** 5.12. Order inside the ticket: matte script and model vendoring,
worker graph and split caption track, gate G3 on 5 real clips, then the Studio half, the
Depth style and the toggle. Blocked by 06.

Gates:

- **G1, hero picks.** A tuning sheet and a held-out sheet, each at least 100 English cues
  and 60 Urdu or Hindi cues (native script and Roman reported separately). Sol labels each
  cue blind with an acceptable hero set (1 to 3 words, or "no hero"), using the surrounding
  text and audio timings. A fluent reviewer labels the Urdu and Hindi cues, or the owner
  checks 30 of Sol's labels. Tune weights on the tuning sheet only. Pass: on the held-out
  sheet, the scorer agrees on 80% or more in each language group, counting a gate-chosen
  "no hero" as agreement only where "no hero" was labelled acceptable, and beats the
  baseline by 10 points or more. If it agrees but does not beat the baseline, ship the
  baseline rule. If neither reaches 80% after one tuning round, build ticket 08.
- **G2, look proof.** Sol compares the proof frames with reference 01 for hierarchy,
  spacing and colour.
- **G3, person matte.** See 5.12.

## 11. Review protocol for Sol

Visual review after 02, 03b plus 03c, 05, 06, 07 and 09:

1. For each fixture case, compare the worker frame, the Studio frame (from the
   `caption-parity` page at the same time) and the reference image.
2. Name any section 6 rule a style breaks.
3. Check heroes on at least 10 fixture or real cues per style.
4. Check the three backgrounds for legibility.
5. Check the motion frames: onset within one frame of the spoken word, nothing reflows,
   unspoken words invisible, nothing clipped by the frame or the safe area.
6. In the Studio, pause mid-entrance, seek backwards and seek into an entrance. The pose
   must match the worker frame at that time.
7. Check one Urdu and one Japanese case per style.

Tolerances at 1080 wide, worker against Studio: baselines 2 px, word left edges 4 px, ink
bounds 4 px.

Automated in the repo: geometry unit tests, the real-libass ink test, the classic ASS
snapshot, decoration point lists (phase 2), every catalog preset serialises with valid
tags. DOM parity is checked from screenshots in review, because Bun has no layout engine.

Code review focus:

- No layout number lives in a renderer. Sizes, gaps, pitch, offsets, rotations and
  durations come from `packages/validators` or `caption-block.ts`.
- The plan is a pure function of the document. Only emphasis overrides are stored.
- One cue derivation. The panel preview and thumbnails use the plan or `captionCueBlock`.
- No `Intl.Segmenter` or locale API in shared caption code.
- Classic presets: the snapshot from ticket 00 is unchanged.
- `studioEditsEqual`, `editorActionSchema`, undo and the contract test know the emphasis
  field.
- Subtitles and the clip timeline read `words[].text`, not `block.texts`.
- Plan gating untouched unless the owner decides otherwise.

## 12. Review history

- **Opus (2026-11-19):** accept with changes. Adopted: per-word events from shared geometry
  with measured advance and ink; entrances spanning to cue end with a pivot rule; roles
  inside an optional `block` and a classic snapshot first; source-time keys; DOM parity by
  screenshot; scorer fixes (minor order, closed lists, stable stretch, masked flag, untimed
  utterances, blind G1 with a baseline, confidence gate before any LLM); ticket 03 split
  into three; `heroFontAsset` deferred; emoji nulled; subtitles on pre-role text; the
  dubbing dependency. Smaller catalog for phase 1.
- **Sol (2026-11-19):** accept with changes. Adopted: shorter, duration-capped motion and
  playhead-driven Studio poses; catalog values (Headline in Inter with corrected gradient
  direction, Editorial as an adaptation of 06, tile metrics for Cutout, Marker marked
  partial, Bubble replaced by Stack from 08); rule changes (tile exemption, approved
  contrasts, floor after fit, reserved space, stable seeds); negation and filler handling
  and reduced weights in the scorer; gradient limited to motions without scale or rotation;
  committed fixtures, full frames, frame times, kept proof artefacts; controls behind
  Advanced; "no emphasis" and 2-word heroes.
- **Not adopted:** contiguous emphasis spans longer than 2 words. Two independent heroes
  per cue (reference 04). Both would complicate roles and rows for a small gain.

## 13. Owner decisions (answered 2026-11-19)

1. **Plan gating:** dynamic styles on every plan, including behind the speaker.
2. **Phrase-aware cue breaks for classic presets:** yes. Existing renders may change; there
   are no production users.
3. **Release:** everything in one release, phases 1 to 4.
4. **LLM rider:** allowed if G1 fails (ticket 08).
5. **Curved text and text behind the speaker:** in this release (tickets 07 and 09).
