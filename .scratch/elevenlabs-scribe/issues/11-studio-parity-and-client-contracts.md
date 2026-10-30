# 11 — Studio preview parity + client/language contracts

**What to build:** Studio (`apps/web` caption-style-engine, caption-fonts, transcript panel): lazy fallback faces (`preload:false`, unicode-range), `lang`/`dir` on cues from effective language/first strong char, word order + karaoke sweep for RTL, locale casing, `joinTranscriptWords` in transcript panel selection/copy; mirror ticket 10's geometry/degradation contract. Language picker: flat Scribe list, Auto first (keep picker everywhere it exists: import, generation setup, recipes); remove accuracy bands/model groups (`languages.ts`, `language-select.tsx`, `advanced-clip-settings.tsx`, `recipes-panel.tsx`, `recipe-picker.tsx`). Regenerate public OpenAPI (`openapi:check`), REST snapshot, MCP tool schemas/descriptions, docs pages mentioning languages.

**Blocked by:** 01, 08, 09 (parity finish after 10)

**Status:** done

**Acceptance:**
- [x] `bun run --cwd apps/web test`, `check:web-split`, `openapi:check`, api-client tests green.
- [x] Browser check (isolated headless session, not the owner's Chrome; harness route removed) of Urdu, Arabic+numbers, Hebrew, Hindi, Japanese, Thai, Georgian, Persian ZWNJ and RTL karaoke sweep: evidence/11/. Comparison against exported libass frames is left to ticket 12 (ticket 10 not merged here).

## Comments

- Studio fonts: `apps/web/app/caption-script-fonts.css` (27 lazy @font-face, unicode-range; manifest ranges for the 18 new faces) + `caption-script-fonts.ts` (stack: requested face → locale face for the cue language → default script faces in worker order → Symbols 2 → Noto Emoji). Drift test in `packages/caption-fonts/src/web-fallback-stack.test.ts`. Ticket 10's precedence function is not merged; the locale face comes from the same `languages` field (ja→JP, yue→TC, ur→Nastaliq) — swap to its function when it lands.
- Measured: English cue loads only the requested face; Japanese loads only Noto Sans JP; Urdu only Nastaliq; Arabic only Noto Sans Arabic. Chrome also fetches Noto Sans Arabic + Hebrew (~380 KB) for a Devanagari cue even with their unicode-ranges excluding it (cause not found).
- No WOFF2 conversion: JP 4.53→3.35 MB, TC 5.68→4.18 MB (~25%), not worth a second binary copy.
- Cue: `lang`/`dir` (first strong char, else language direction), per-word `dir`, spaces from `hasSpaceBefore`/`spaceBefore`, RTL karaoke sweep, `\fsp0`-equivalent letter-spacing runs, typewriter whole-word for disabled-spacing scripts, `font-synthesis: none`, fit-to-width re-measures on `document.fonts` loadingdone/ready.
- Drive-by: karaoke base fill of the active word is the primary colour (as `\kf` does), so the sweep is visible; previously the whole word was already highlight-coloured.
- `clipInfo.captionLanguage` (transcript language ?? project language) added to the Studio bootstrap via `projectService.getCaptionLanguage`; threaded into the composition plan, caption panel and transcript panel (label + `lang`/`dir`).
- Contracts: OpenAPI/REST snapshot/MCP schemas already carried the registry enum; added tests that the enum equals the registry and no provider/accuracy wording appears. Docs: uploads.mdx, quickstart.mdx.
- `apps/worker` `ingest.test.ts` has 3 failures that also fail at the baseline commit.
