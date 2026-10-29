# 08 - Burn shared emoji and enforce glyph coverage

**What to build:** Make exported active-word emoji match Studio and report unresolved text/emoji glyphs explicitly.

**Blocked by:** [07 - Tone-map HDR before composing SDR layers](07-hdr-to-sdr.md)

**Status:** done

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/caption-ass.ts`
- `apps/worker/src/caption-ass.test.ts`
- `apps/worker/src/worker-process.ts`
- `apps/worker/src/composition-ffmpeg-adapter.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/brand-font-resolution.ts`
- `apps/worker/src/brand-font-resolution.test.ts`
- `packages/caption-fonts/src/emoji.ts`
- `packages/caption-fonts/src/emoji.test.ts`
- `packages/caption-fonts/src/index.ts`
- `packages/caption-fonts/package.json`
- `packages/caption-fonts/emoji/atlas.png`
- `packages/caption-fonts/emoji/atlas.json`
- `packages/caption-fonts/emoji/LICENSE.txt`
- `packages/caption-fonts/fonts/NotoEmoji-Regular.ttf`
- `packages/caption-fonts/fonts/NotoSansSymbols2-Regular.ttf`
- `packages/caption-fonts/licenses/noto-fallbacks-OFL.txt`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine.test.ts`
- `apps/worker/src/composition-emoji.test.ts`
- `apps/worker/src/__fixtures__/render-golden/expected/08-emoji-and-glyphs.json`

Write-set amendments (2026-10-29, owner decisions: burn emoji, fallback chain independent of host fonts):

- `apps/worker/src/caption-glyphs.ts`, `apps/worker/src/caption-glyphs.test.ts` (new: fallback-chain planner, typed failure, stderr classification)
- `packages/caption-fonts/src/fallback-fonts.ts`, `packages/caption-fonts/src/fallback-fonts.test.ts` (new: pinned chain registry, shaped coverage/advance)
- `packages/caption-fonts/src/paths.ts` (atlas path), `packages/caption-fonts/scripts/build-emoji-atlas.ts` (reproducible atlas build)
- `packages/caption-fonts/fonts/NotoSans{,Arabic,Hebrew,Devanagari,Thai,SC,KR}-Regular.{ttf,otf}` (the "pinned Noto script" faces, vendored instead of the image's apt packages so macOS and Linux match)
- `apps/worker/runtime-lock.json`, `apps/worker/scripts/check-render-environment.ts` (pin the fallback faces; `fingerprintIdentity` excludes them so the pre-08 golden baseline stays comparable)
- `apps/worker/scripts/render-golden.ts`, `apps/worker/scripts/render-golden.test.ts` (no mirrored glue: harness calls the same `compileCompositionPlanCaptions` and diagnostics classifier; new `change: "glyph-coverage"`)
- `apps/worker/src/composition-ffmpeg-adapter.test.ts`, `apps/worker/src/tasks/captioned-video-render.test.ts`, `apps/worker/src/tasks/composition-command.test.ts` (call sites of the changed `compileCompositionPlanCaptions` / `renderCaptionTrack` return type)
- `apps/web/tsconfig.json`, `apps/web/next.config.ts` (web resolves `@narriflow/caption-fonts/emoji` and the atlas PNG; no new dependency or lockfile change)

## Implementation

1. Compare upstream Noto raster artwork against build-time NotoColorEmoji rasterization using the sources linked in the spec; vendor a checksummed shared atlas and license. Use the same sequence resolver/images in Studio and FFmpeg overlays.
2. Consume existing plan emoji and active-word cue geometry at 0.8em above the word. Implement exact-sequence, semantically equivalent presentation sequence, then flagged monochrome fallback; unresolved clusters fail caption_glyph_unavailable.
3. Enforce requested face -> saved built-in -> pinned Noto script -> Symbols 2 -> supported monochrome emoji text coverage. Keep Noto CJK/script artifacts pinned by 01 and add only the declared symbol/monochrome assets here.
4. Propagate missing-glyph/fontselect and drawtext parsing diagnostics even on successful process exit. Use grapheme clusters for reveal/lookup and test actual images/bounds, not only font existence.

## Acceptance

- [x] Studio and export use identical artwork/timing/size/placement for active emoji; family/flag/skin-tone/ZWJ clusters stay intact.
- [x] Emoji-disabled and ordinary Latin output remain exact. Only the accepted emoji/glyph defect references change.
- [x] RTL/CJK and missing-uploaded-font fixtures have actual glyphs and preserve the intended cue geometry.
- [x] Unresolved glyph emits a typed failure/visible notice and cannot be marked ready; a monochrome fallback emits glyph_fallback_used.
- [x] Shared-web code has no backend imports; export cue derivation remains in composition-plan.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/caption-ass.test.ts apps/worker/src/composition-emoji.test.ts packages/caption-fonts/src/emoji.test.ts
bun run check:web-split
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Base `dev` HEAD `a51e2e8283`, uncommitted. Host: macOS arm64, FFmpeg 8.0.1 (libass 0.17, CoreText font provider), Bun 1.4.2. The pinned Linux image is unbuilt (ticket 21); nothing here ran in it.

**Gate** `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-08`: see Comments for the final counts. Fingerprint id stays `90cf30a3...` (fallback faces are outside the identity; pinned by the lock instead).

**Stills** `/tmp/narriflow-golden/ticket-08/` (`final/` has the curated set): `emoji-sheet.png` (keyword emoji above the active word, tilt, ZWJ family), `script-sheet.png` (Arabic, Hebrew/Thai/Hindi, Chinese/Japanese/Korean, Latin + CJK + text emoji), `golden-*` (the golden fixtures: emoji-sequences cues 0-3, rtl-arabic, cjk-dense). Baseline boxes/Nastaliq are gone; Arabic is Noto Sans Arabic in correct RTL order.

## Comments

**Final gate** (`/tmp/narriflow-golden/candidate-08`, log `/tmp/narriflow-golden/verify-08.log`): exit 0. Normal 18/18 identical (plan, ASS, argv, graph, frame hashes, PCM, ffprobe, loudness, decode) except `rtl-arabic-captions` and `cjk-dense-captions`, which pass through the new `change: "glyph-coverage"` (ASS script, frames and libass font lines may differ; candidate must report no host-font lookup; PCM/argv/ffprobe stay exact). Known defects: 14 corrected and passing (12 earlier tickets + `emoji-sequences`, `missing-glyph`), 4 expected failures/guards unchanged, 0 xpass, 0 changed. Every Latin and emoji-free case is bit-identical, so no frames-identical proof was needed for them.
Tests: `cd apps/worker && bun test` 892 pass; `bun test packages/caption-fonts` 31 pass; web Studio dir 397 pass (incl. 2 new `CaptionEmoji` tests); `bun run --cwd apps/worker typecheck`, caption-fonts and web typecheck clean; biome clean (1 pre-existing warning); `bun run check:web-split` passes.

Design (settled)
- libass cannot draw colour emoji, and on macOS (CoreText provider) it ignores `fontsdir` for fallback and `FONTCONFIG_FILE`. So the worker chooses the face itself: `caption-glyphs.ts` plans per grapheme cluster (requested -> saved built-in -> Noto Sans / Arabic / Hebrew / Devanagari / Thai / SC / KR -> Symbols 2 -> monochrome Noto Emoji; emoji-presentation clusters go to the last two) and the ASS switches with explicit `{\fn..\fs..}` runs. Only vendored files are used, so the host cannot decide a glyph. Text the requested face covers gets no overrides (byte-identical). Fallback runs are sized to the same em, and cursive/complex-script runs get `\fsp0` (libass stops joining and bidi-ordering a line under non-zero `\fsp`; browsers ignore letter-spacing there too).
- Coverage is shaped (fontkit layout, `.notdef` counts as missing). A code point no face has throws `CaptionGlyphUnavailableError` (`caption_glyph_unavailable`, permanent) before any encode. After every encode the worker also scans ffmpeg stderr (`stderrLinePattern` in `worker-process.ts`, because the bounded tail drops early lines): "failed to find any fallback" fails the variant even on exit 0; host-font lookups and drawtext/open-font lines are logged `clip_render_caption_diagnostics` (degraded). Monochrome use logs `glyph_fallback_used`.
- Emoji: the plan's active-word emoji becomes an overlay schedule (`CaptionEmojiOverlay`) from `renderCaptionTrack`; the FFmpeg caption stage composites it from the shared atlas via `movie`/`crop`/`scale`/`overlay` (no extra input slots, three compile paths share `compileCompositionPlanVisualLayers`), 0.8em-font-equivalent size, bottom edge on the line-box top, centred on the word, turned with the cue tilt, window = the word segment. Studio's `CaptionEmoji` draws the same atlas cell with the same geometry. Resolver order: exact (Noto names files without U+FE0F), presentation-selector equivalent, then monochrome glyph (`glyph_fallback_used`) for a single pictograph, else `caption_glyph_unavailable`. No tone or ZWJ downgrade to the base emoji.
- Comparison recorded in `emoji/LICENSE.txt`: upstream 2D PNGs (Apache-2.0 per the repo README) over rasterizing the installed NotoColorEmoji, which would need fontTools and GSUB walking at build time. Atlas: 29 images at 128px (keyword table + test sequences), 135 KB, hashes in `atlas.json`, rebuild with `packages/caption-fonts/scripts/build-emoji-atlas.ts`.
- Fingerprint: new fonts in `fonts/` would change the golden fingerprint id (it hashed the whole directory). `captionFonts` now excludes the lock's `fallbackFonts`, which are pinned and enforced separately (`lockFindings`), so the pre-08 baseline stays comparable.
- Unmeasurable cues (any fallback glyph) now fit the frame: width is the sum of shaped run advances; word boxes, pills and plates still do not apply (as before).

Known gaps and requests
- Flags are not in the 2D PNG set (Noto builds them from region-flags). A plan emoji that is a flag fails `caption_glyph_unavailable`; literal flag/ZWJ/skin-tone clusters in transcript text render as separate monochrome glyphs with `glyph_fallback_used` (`sequenceSplit: true`), not colour. Colour inline emoji in running text needs measured word boxes and is future work with emoji editing.
- Emoji overlays are static for their window: the word's entrance motion, cue fade and neon flicker are not applied to the emoji (timing/size/placement match; animation does not).
- Studio shows nothing for an emoji the atlas lacks (no monochrome font or notice there yet). Studio text layers/watermark still use `drawtext` with host font patterns: only the stderr scan is new for them; no pre-render coverage check (ticket 16/17 candidates).
- `emoji-sequences` corrected contract uses `video.saturatedPixels >= 100`: the metric samples 270px-high frames where one 0.94em emoji is about 12px, so 175 is the real value (the baseline's 500 was never calibrated).
- Not verified here: Linux image render (libass/fontconfig provider; same name-matching mechanism as the display faces), and a `next build` of the new `@narriflow/caption-fonts/emoji` alias + PNG import (typecheck and bun tests pass; ticket 32 browser pass should look at the Studio emoji). `apps/worker/Dockerfile` still apt-installs fonts-noto-*; captions no longer depend on them (request to ticket 21 to drop or keep for drawtext).
- Fonts added: 16 MB of OFL Noto binaries (CJK SC 8.3 MB, KR 4.6 MB) under `packages/caption-fonts/fonts`.


### Addendum 2026-10-29 (coordinator): no recoverable render failure

Decorative or rare content no longer kills a clip. Supersedes the typed-failure parts above.
- A code point no pinned face draws is left out of the burned text (only that code point, `CaptionGlyphPlanner` per-cluster, never the cue). The track returns `omitted: [{codePoint, cueIndex}]`; the attempt logs `caption_glyph_omitted` per entry and adds `caption_glyph_omitted` to the render's persisted analytics `fallbackCode` (the only structured per-render channel that exists without a services/schema change; detail is in the log).
- A plan emoji with no atlas cell and no monochrome glyph (flags, anything outside the atlas) is skipped: `emojiSkipped: [{emoji, cueIndex}]` on the track, `caption_emoji_skipped` log and `fallbackCode`. Plan emoji come only from `CAPTION_EMOJI_MAP` (`emojiForWord` in composition-plan is the sole producer); `emoji.test.ts` asserts every map emoji has an atlas cell, so a map addition fails CI. Studio renders nothing for a missing cell.
- Post-encode stderr scan kept: libass "failed to find any fallback" on a zero exit rewrites the ASS with those code points forced out (`omitCodePoints`), logs `clip_render_caption_glyph_missing`, and runs the same command once more; a second report fails the variant `caption_glyph_unavailable` (permanent, details in the message). Tests: `clip-render-attempt-core-paths.test.ts` (one re-render uploads; a surviving error fails typed), `caption-ass.test.ts`, `caption-glyphs.test.ts`, `composition-emoji.test.ts` (real FFmpeg: omitted glyph and flag emoji both burn clean).
- Harness: `missing-glyph` contract is now `render.ok` true, `captions.glyphsOmitted >= 2`, `captions.emojiSkipped == 0`.
- Gate `/tmp/narriflow-golden/candidate-08b`: exit 0, normal 18/18 identical, 14 corrected and passing (`missing-glyph` 3/3), 4 unchanged. `bun test` apps/worker 897 pass; web Studio 397 pass; `bun run --cwd apps/web build` exit 0 (atlas PNG emitted to `.next/static/media`).
- Request (services owner): a first-class render-result field for caption warnings (code points, cue indexes) instead of the analytics `fallbackCode`.
