# Audio/Music panel design QA

> Scope note: this document covers visual implementation QA only. The later
> end-to-end verification found functional parity gaps—most importantly the
> missing timeline-native audio block and empty curated catalog. See
> `.codex-audit/audio-music-deep-verify/report.md` for the current verdict.

- Source visual truth: `/Users/murtaza/Desktop/Screenshot 2026-08-10 at 7.32.05 PM.png`
- Implementation screenshot: `/Users/murtaza/Documents/dev/narriflow/.codex-audit/audio-music/10-narriflow-populated.png`
- Combined comparison: `/Users/murtaza/Documents/dev/narriflow/.codex-audit/audio-music/15-reference-vs-narriflow.png`
- Browser viewport: 2560 × 1296 CSS px, desktop Chrome, dark Narriflow studio theme
- Source pixels: 400 × 1276
- Implementation pixels: 2560 × 1296; compared from the 300 × 1000 right-panel crop at x=2260, y=48
- Density normalization: source kept at 1×; implementation crop scaled proportionally and padded to 400 × 1276 before the 800 × 1276 side-by-side comparison
- State: Music library open with one uploaded row available, preview controls closed

## Full-view comparison evidence

The combined image verifies the same hierarchy as the Vizard reference: compact Music/Sound-effects tabs, search plus upload action, horizontal All/Saved/category filters, artwork-led rows with preview and secondary actions, and a single scrolling panel. Narriflow intentionally keeps its graphite studio chrome and ultramarine accent instead of copying Vizard's light theme. Existing Narriflow mix/source-audio controls remain below the library as collapsible, clearly separated sections.

No P0/P1/P2 visual differences remain. The main visible density difference is content, not layout: the reference has a populated curated catalog while the local Narriflow database currently has no curated rows. A generated uploaded test row was used to verify the populated state and was deleted after QA.

## Focused region comparison evidence

The right-panel crop in the combined image was readable at 1:1 and sufficient to check the critical surfaces:

- Fonts and typography: existing Archivo/mono studio hierarchy is preserved; labels, duration metadata, and section eyebrows remain readable without wrapping.
- Spacing and layout rhythm: tab underline, 34px search control, 26px filter chips, 40px cover row, and action circles align with the reference's compact cadence.
- Colors and tokens: all editor chrome uses existing `studio.*`, semantic warning, and accent tokens; the deliberate dark-theme deviation is coherent.
- Image quality and assets: music and SFX use separate 256px raster cover art; thumbnails are sharp at 40px and are not CSS placeholders.
- Copy and content: Music, Sound effects, Saved, search, upload, mix, source audio, and placement labels are explicit and accessible.

## Interaction evidence

- Music/Sound-effects tabs switched correctly.
- Search and clear controls rendered with accessible names; filtering logic is covered by unit tests.
- Preview playback exposed an inline scrubber and elapsed/total time.
- Save/Unsave persisted through the new favorite API and the Saved filter.
- Use applied music and exposed volume, start offset, fades, and ducking.
- SFX Add created a playhead placement with timecode, volume, and remove action.
- Upload management opened correctly. Chrome blocked programmatic local-file selection because the ChatGPT extension lacks file-URL permission; the same generated WAV was uploaded, listed, previewed, used, and deleted through Narriflow's service path instead.
- Browser console checked: no application errors; only Clerk's standard development-key warning.

## Comparison history

1. Initial implementation capture showed the library request failing because the running Next.js process still held the pre-migration Prisma client.
2. Applied the new favorite migration, regenerated Prisma, restarted the dev server, and recaptured.
3. Post-fix evidence showed the empty state, then populated Music, preview, Saved, mix, SFX, and placement states with no actionable P0/P1/P2 issues.

## Follow-up polish

- P3: Populate the curated AudioAsset manifest/R2 library so category chips and catalog density match the reference in production.
- P3: Per-track artwork can be added later if content operations provides art metadata; the two current system covers are intentionally reusable defaults.

final result: passed
