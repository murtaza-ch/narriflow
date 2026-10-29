# 08 - Burn shared emoji and enforce glyph coverage

**What to build:** Make exported active-word emoji match Studio and report unresolved text/emoji glyphs explicitly.

**Blocked by:** [07 - Tone-map HDR before composing SDR layers](07-hdr-to-sdr.md)

**Status:** ready-for-agent

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

## Implementation

1. Compare upstream Noto raster artwork against build-time NotoColorEmoji rasterization using the sources linked in the spec; vendor a checksummed shared atlas and license. Use the same sequence resolver/images in Studio and FFmpeg overlays.
2. Consume existing plan emoji and active-word cue geometry at 0.8em above the word. Implement exact-sequence, semantically equivalent presentation sequence, then flagged monochrome fallback; unresolved clusters fail caption_glyph_unavailable.
3. Enforce requested face -> saved built-in -> pinned Noto script -> Symbols 2 -> supported monochrome emoji text coverage. Keep Noto CJK/script artifacts pinned by 01 and add only the declared symbol/monochrome assets here.
4. Propagate missing-glyph/fontselect and drawtext parsing diagnostics even on successful process exit. Use grapheme clusters for reveal/lookup and test actual images/bounds, not only font existence.

## Acceptance

- [ ] Studio and export use identical artwork/timing/size/placement for active emoji; family/flag/skin-tone/ZWJ clusters stay intact.
- [ ] Emoji-disabled and ordinary Latin output remain exact. Only the accepted emoji/glyph defect references change.
- [ ] RTL/CJK and missing-uploaded-font fixtures have actual glyphs and preserve the intended cue geometry.
- [ ] Unresolved glyph emits a typed failure/visible notice and cannot be marked ready; a monochrome fallback emits glyph_fallback_used.
- [ ] Shared-web code has no backend imports; export cue derivation remains in composition-plan.

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

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
