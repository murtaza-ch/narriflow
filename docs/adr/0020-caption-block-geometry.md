# Caption Blocks keep both renderers; shared geometry places every word

**Status:** accepted by the owner, 2026-11-19, with the dynamic captions specification (`.scratch/dynamic-captions/spec.md`, decisions 1 and 2).

Dynamic Styles draw a cue as a Caption Block: one to three rows in which one word, the hero, is several times the size of the rest, in its own face and colour. Narriflow already renders every caption twice. The worker writes ASS and burns it in with libass (`apps/media/src/caption-ass.ts`). The Studio paints the same caption layers as DOM (`caption-style-engine.tsx`). For classic presets the worker lets libass lay out the whole line and the Studio uses inline CSS flow. The two agree only because each line has one font and one size.

## Decision 1: keep both renderers

Running libass in the browser (JASSUB) would remove the mirror. It needs `caption-ass.ts` and HarfBuzz font loading working in the browser, a canvas overlay in place of the DOM one that drag, resize and selection rely on, and an answer for 24 live preset thumbnails with tens of MB of fallback fonts. That is weeks of work, and Caption Blocks do not need it. The real cost of two renderers is that each effect is written twice, so Dynamic Styles keep their effects few and describe the rest as data (`CAPTION_DYNAMIC_STYLES`, `CAPTION_MOTIONS`).

## Decision 2: shared code places every word; renderers measure and paint

Each renderer measures every word alone, in its role's face and letter spacing, and reports its advance and ink at 1 em. The worker uses `layoutCaptionLine` (HarfBuzz). The Studio uses Canvas `measureText` after its fonts load, with fractional values. `layoutCaptionBlock` (`@narriflow/caption-fonts/caption-block`, browser-safe) turns those measurements into each word's size, centre, rotation and pivot in canvas px. It applies role sizes, word gaps, hero fill, the fit scale, row pitch from measured ink, bidi order per row, stagger, tilt, anchoring and the safe-area shift over the reserved entrance travel. The worker emits one ASS event per word per paint layer at that position, with `\pos` and `\org` at the word's centre. The Studio positions each word absolutely, with its transform origin at the same centre. Neither renderer lays text out across words.

The composition plan stays pure. It groups cues, assigns Caption Roles as a second pass over a target's cues, and attaches the block (roles, display texts, Word Keys, rows, seed) without measuring. Geometry needs measurement, so it runs in each renderer, but through the one shared function.

## Considered options

Letting libass and CSS each lay out a mixed-size line was rejected. The two would have to agree on gaps between sizes, baselines across faces, kerning (libass does not kern unless the script says `Kerning: yes`) and bidi runs, and nothing could test DOM layout in Bun. Measuring in the plan was rejected because the plan runs in the browser and the worker without fonts. The worker's HarfBuzz and the browser's Canvas each measure faithfully for their own painter, and in the look proof (ticket 02) they placed every baseline and size identically.

## Consequences

No layout number lives in a renderer. Sizes, gaps, pitch, offsets, rotations and durations come from `packages/validators` or `caption-block.ts`. Each renderer owns its measurement and its paint layers only. Classic presets keep their single-line painters, so the decision changes nothing for them except phrase-aware cue breaks (spec 5.4), which apply to every preset. Cue breaks are a grouping change, not a geometry one. DOM parity is checked from screenshots in review, because Bun has no layout engine. When the worker cannot shape a face with HarfBuzz (an uploaded WOFF2 text font), it falls back to the classic line, and the Studio keeps the block. This mismatch is accepted.
