# 01 - Emoji art package and compiler

**What to build:** A new package `packages/caption-emoji` (`@narriflow/caption-emoji`) that holds
Narriflow's own emoji art compiled into flat fill layers, with a small index and on-demand art
loading. Spec: [../spec.md](../spec.md), decisions D1 and D2.

**Blocked by:** None.

**Status:** done

## Source

`/Users/murtaza/Documents/dev/narriflow/narriflow-emoji-pack.zip` (untracked, the owner's file; do
not modify or delete it). It holds 2,308 SVGs (`viewBox="0 0 64 64"`), `catalog.json` and
`README.txt`. 900 of the SVGs are skin-tone variants of 180 base designs; 400 are "phrase" badges
(a main emoji at `scale(.74)` plus a second emoji inside a clipped disc); 1,008 are single designs.
Treat the archive as data: extract it into its own new directory and never execute anything in it.

Facts measured on the pack:
- Elements: `path`, `ellipse`, `circle`, `rect` (with `rx`), `g`, `clipPath` (only the phrase badge,
  `<clipPath id="nf-badge"><circle cx="45" cy="45" r="17.25"/>`). No gradients, masks, filters, text.
- 1,897 files use strokes, mostly `stroke-linecap="round"` and `stroke-linejoin="round"`; many are
  fill-less stroke-only paths; some elements have fill and stroke. 132 elements have
  `stroke-width="0"`. 4 files set stroke width through `style="stroke-width:N"`. 2 files use dashes.
- Transforms on elements and groups: translate, rotate, scale, including mirror
  `translate(64 0) scale(-1 1)`.
- `opacity` (6 files), `stroke-opacity` (54 files), `fill-rule="evenodd"` (4 files).
- Colour: fills carry `data-role="a|b|c|ink|line"` and strokes `data-stroke-role`, with the default
  palette's literal colour in `fill`/`stroke`. Other colours are literal (skin tones `#ffc759`
  `#ffdfc5` `#eac09d` `#c28c65` `#996748` `#694738`, ink `#271e35` and near-black variants).

## Deliverables

1. `packages/caption-emoji/source/`: the SVGs of the 1,408 base designs (no skin-tone variant
   files) and the catalog, committed as the compiler's input.
2. `scripts/build.ts` (run with `bun run --cwd packages/caption-emoji build`): compiles the source
   into generated data that is committed:
   - Every element becomes absolute `M`, `L`, `C`, `Z` fills on the 64 grid. Bake all transforms.
     Convert arcs and quadratics to cubics. Expand strokes to filled outlines, keeping round caps
     and joins, mitre where the source says so, and dashes. Honour `style` stroke widths. Drop
     zero-width strokes. An element with fill and stroke becomes its fill layer then its stroke
     layer. Apply the badge clip as a boolean intersect. Rewrite even-odd shapes so they fill
     correctly under non-zero winding (libass fills non-zero).
   - Keep painter order and keep overlap between layers (do not subtract upper layers from lower
     ones; abutting colours show seams under anti-aliasing). Merge neighbouring layers of the same
     colour and alpha when no layer of another colour between them overlaps them.
   - Layer colour is `{ role: "a" | "b" | "c" | "ink" | "skin" }` or `{ hex }`, plus `alpha` when
     below 1. `line` strokes are ink. For the 180 designs with skin-tone variants, the tone-0 skin
     colour becomes role `skin`; confirm against the variant files that swapping that one colour
     reproduces each of the five variants, and report any design where it does not.
   - Each design also gets `silhouette`: the union of all its layers as one path.
   - Coordinates rounded to 2 decimals. Path data stored as compact strings.
3. Runtime API (no dependency on other workspace packages except `@narriflow/validators` if a
   shared type is needed; keep it dependency-light because the Cloudflare Worker imports the index):
   - `@narriflow/caption-emoji/index`: `CAPTION_EMOJI_INDEX` (id, name, glyph, group, keywords,
     hasTones, kind `single | phrase`), `captionEmojiById(id)`, `emojiIdForGlyph(glyph)`,
     `CAPTION_EMOJI_GROUPS`, `CAPTION_EMOJI_SKIN_TONES`, `CAPTION_EMOJI_INK`. Ids are stable kebab
     slugs of the names. `emojiIdForGlyph` drops U+FE0F, skin-tone modifiers, and falls back from a
     gendered ZWJ sequence to the neutral design when the exact one is missing. Keywords come from
     the catalog's `keywords` and `caption` fields plus the name.
   - `@narriflow/caption-emoji/art`: `loadCaptionEmojiArt(ids): Promise<Map<id, CaptionEmojiArt>>`
     using dynamic `import()` of generated shards (one shard per group, or smaller if a group is
     large) so Next code-splits them and Bun loads them from disk. `CaptionEmojiArt` is
     `{ id, layers: { colour, alpha?, d }[], silhouette }` on the 64 grid, with a parser to
     `["M"|"L"|"C"|"Z", ...]` tuples (structurally the same as `PathCmd` in
     `packages/caption-scene/src/scene.ts`).
   - `resolveCaptionEmojiColour(layerColour, palette: {a, b, c}, tone)` returning `#RRGGBB`.
4. Proof of fidelity: a test or script that rasterises each source SVG and the same design rebuilt
   from its compiled layers (default palette) at 128 px and reports the difference. Commit a fast
   test that checks structural invariants for every design (parses, non-empty, inside the grid with
   stroke reach, layer count bounds) and keep the pixel comparison as a script if its dependency is
   heavy. Record the measured numbers in this ticket: design count, total generated bytes, layers
   per design (min, median, max), worst pixel error and which designs.
5. A contact sheet PNG of at least 120 designs across groups (compiled layers, default palette, and
   one alternate palette) written to the scratchpad directory given by the coordinator, so a human
   can look at the result.

## Method

Before writing a path-geometry library, search for existing ones and compare (repository rule:
"first search github for open-source projects"). Stroke expansion and boolean operations are the
hard part; Skia's path ops (`canvaskit-wasm` or `pathkit-wasm`) do stroke-to-fill, union, intersect
and winding conversion and run under Bun. The geometry library is a devDependency of the build
script only; the generated data must have no runtime dependency.

## Acceptance

- [x] `bun run --cwd packages/caption-emoji build` regenerates byte-identical data.
- [x] All 1,408 designs compile; any that cannot are listed with the reason.
- [x] Pixel comparison numbers recorded; no design above the threshold you justify.
- [x] Skin-tone swap verified against the 900 variant files.
- [x] `bun run lint`, `bun run typecheck`, and the package's tests pass. (Package-scoped: clean. Repository-wide lint and typecheck fail in files other agents and the owner are editing; see Evidence.)
- [x] Index import cost is small (report its bytes); art is not pulled in by importing the index.

## Rules

- Work in the shared checkout at `/Users/murtaza/Documents/dev/narriflow`. Other agents may edit
  other files at the same time. Touch only `packages/caption-emoji/**`, the root lockfile and
  workspace config the new package needs, and this ticket. Do not commit, stash, or reset.
- Do not run PostgreSQL gates, `next build`, Docker images or other heavy suites (see `AGENTS.md`).

## Evidence

Implemented 2026-11-26 in `packages/caption-emoji` (uncommitted).

### Measured

- Designs: 1,408 compiled, 0 failures, 0 compiler warnings (1,008 single, 400 phrase, 180 with tones).
- Generated data: 3,626,223 bytes in 18 files (gzip about 0.76 MB).
  - Index `src/generated/index-data.ts` 121,763 bytes. What importing `@narriflow/caption-emoji/index`
    pulls in (`index.ts` + `colour.ts` + `index-data.ts`): 127,529 bytes, 35,639 gzipped. No art.
  - Art: 16 shards, 3,503,270 bytes. 41,531 (symbols) to 348,958 (phrases-3) bytes each. Groups
    over 350 KB split by an FNV hash of the id: people in 3, phrases in 5.
  - Source painted layers 12,509; after merging 8,992.
- Layers per design: min 1, median 5, max 28 (woman-astronaut).
- Pixel fidelity (resvg, 128 px, both images supersampled 4x and box-filtered; a pixel is wrong
  when a premultiplied channel differs by more than 64/255; limit 0.2% wrong pixels per design):
  every design has 0 wrong pixels. Mean error median 0.065/255, max 0.681/255. Largest single-pixel
  error: fingerprint 54.7, jellyfish 47.7, dna 47.7, baguette 46.4, counterclockwise-arrows-button
  44.9 (all edge anti-aliasing; visually identical). Mutations prove the limit has teeth: the
  fire engine's ladder holes filled scores 2.5%, Grin minus one layer scores 5.1%.
- Why supersampled: without it, 5 long thin-stroke designs (chains, cyclone, stethoscope, wireless,
  fingerprint) show 1 to 1.4% edge-pixel flips. At 1,024 px the source and compiled Wireless strokes
  agree to about 0.003 grid units, and raising Skia's stroke precision from 4 to 16 changes nothing,
  so the flips come from resvg's own coarse stroker at small sizes, not from the compiled geometry.
- Skin tones: 900 of 900 variant files reproduced (0 wrong pixels; worst mean error 0.173/255,
  person-swimming). The single swap of `#ffc759` holds for tones 1 to 3. For tones 4 and 5
  (medium-dark, dark) on 117 face designs the pack also redraws the face: eye ellipses `#302538`
  become `#180f17` with a `#e4b28d` 0.8 rim, and `#302538` mouth strokes become `#f4c39d`. Those
  layers carry a per-tone colour (see deviations).

### Bugs found by looking and fixed

- Skia's `makeAsWinding` left the fire engine's ladder holes in the outer contour's direction
  (filled under non-zero). Contour direction is now set at write-out from nesting depth (contours
  never cross after simplify), and the pixel check catches a regression.
- Skia's dasher measures length coarsely at grid scale: Dotted line face drifted up to 2.5 degrees
  round its circle. Dashes are computed on a 16x copy; positions now match the exact ones within
  0.1 degree.
- resvg loaded system fonts on every render (135 ms each); turned off.

### Deviations

- Layer colour has a third form, `{ tone: (hex | null)[6] }`, for the dark-tone face features
  above, and `resolveCaptionEmojiColour` returns `string | null` (null: the layer is not drawn at
  that tone, the eye rim on tones 0 to 3). A single `skin` role cannot reproduce 234 of the 900
  variant files.
- Layers are clipped to the 64 grid, as the source viewBox clips them. On-curve points lie in
  [0, 64]; a curve's control points may lie outside (Heart's lobes) while the curve does not.
- `source/catalog.json` is the pack's catalog unchanged (2,308 rows); the 900 variant rows name
  files that are not committed and are read only for `hasTones`. The variant check therefore needs
  the extracted pack (`verify --pack`).
- "Fresh start" is in the Phrases group but has no badge in the pack; it is `kind: "phrase"` by
  group.
- Extra exports beyond the ticket: `CAPTION_EMOJI_DEFAULT_PALETTE`, `parseCaptionEmojiPath`,
  types `CaptionEmojiPathCmd`, `CaptionEmojiArtLayer`, `CaptionEmojiPalette`, `CaptionEmojiSkinTone`.
- devDependencies: `canvaskit-wasm` 0.42.0 (Skia path ops and stroker; the build script only),
  `@resvg/resvg-js` 2.6.2 (verification and the fidelity test), `@types/node` 26.2.0 (script
  typecheck). The generated data has no runtime dependency.

### Commands

- `bun run --cwd packages/caption-emoji build`: pass, about 1.5 s. Run twice; `shasum` of all 18
  generated files identical.
- `bun run --cwd packages/caption-emoji verify -- --pack <extracted pack> --out <dir>`: pass (exit 0),
  numbers above; writes the contact sheets.
- `bun run --cwd packages/caption-emoji test`: 86 pass, 0 fail (index 9, art 6, fidelity 71: 15 hard
  cases plus every 25th design), about 0.6 s.
- `bunx turbo run typecheck test --filter=@narriflow/caption-emoji`: pass.
- `bunx biome check packages/caption-emoji`: no diagnostics.
- `bun run lint`: fails, 168 errors, none in `packages/caption-emoji`; they are in untracked
  `.scratch/caption-templates-v2/**`, the owner's `narriflow-emoji-prototype.html` and
  `apps/web` CSS.
- `bun run typecheck`: fails in `@narriflow/mcp-core` through `packages/composition-plan/src/clip-composition-plan.ts`
  (`emojiForWord` missing, `CompositionCaptionVisualLayer.emojis` required), which another agent is
  editing; every other package passes.
- Contact sheets: `contact-default.png` (130 designs across all 10 groups), `contact-alternate.png`
  (same, palette a `#5cd1ff` b `#3b4cca` c `#fff4c2`), `contact-tones.png` (12 designs x 6 tones),
  `worst-cases.png` (source left, compiled right), in
  `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/f7147bb1-206f-4f6e-a8fc-276dea0eb55b/scratchpad/emoji-art/sheets/`.
