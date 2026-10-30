# Sol review, 2026-10-30

Reviewed the three requested tracks in the uncommitted `dev` working tree against `AGENTS.md` and this effort's `brief.md`. Kept source read-only; the only file written is this report. No processes were stopped, migrations applied, or database suites started.

No P0/P1 blocker found. Four P2 correctness/parity findings follow, plus one P3 UX finding.

## Findings

### 1. P2: Valid worker diagnostics disappear for Bengali, Tamil and Telugu characters

**Location:** `packages/validators/src/clip.ts:169`, `packages/services/src/clip.service.ts:306`; producer at `apps/worker/src/caption-glyphs.ts:171`.

**Scenario:** The existing worker labels omitted code points without zero padding. Actual planner calls for Bengali `অ`, Tamil `அ`, and Telugu `అ` produce `U+985`, `U+B85`, and `U+C05`. The new schema requires four to six hex digits, so each fails validation. The tolerant read then returns null for the whole object, hiding other valid omissions and skipped emoji too. These are ordinary writing systems, not just malformed input.

**Fix:** Format worker labels with the shared four-digit-minimum formatter before persistence. Add a producer-to-read-model test using one of these characters mixed with `U+13000`; assert both survive. No compatibility layer is needed under the repo's pre-production policy.

### 2. P2: Studio's omission warning scans text that the export will not draw

**Location:** `apps/web/lib/caption-omissions.ts:40`, `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/captions-panel.tsx:719`.

**Scenario:** Cut out a word containing an unsupported character. The new helper still scans all transcript words, so the warning remains and tells the user to replace text that is absent from the export. Reproduced with `fine` at 0 to 1 seconds, `U+13000` at 4 to 5 seconds, and a cut at 3 to 6 seconds: `deriveCaptionCues` returns only `FINE`, while the helper returns one omission. Caption masks and text formatting can also change what is actually drawn. The fallback-font union also cannot prove that an uploaded custom font lacks a character.

**Fix:** Check the canonical rendered cue text from `deriveCaptionCues`, including cuts, masks and formatting, and invalidate when those inputs change. Avoid stating a definite omission when coverage of the selected custom font is unknown. This follows AGENTS.md's requirement to share cue derivation.

### 3. P2: Emoji motion still does not match the export clock

**Location:** `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine.tsx:515` and `:533`; timing supplied by `interactive-caption-overlay.tsx:196` in the same directory.

**Scenario:** Studio generates poses only through `enterSec` and holds opacity at one until unmount. Export fades during the final 80 ms. For a 600 ms window, the shared pose has alpha 0.5 at 560 ms, but Studio remains fully opaque. Seeking into the middle of a word also mounts a fresh entrance animation instead of displaying that timestamp's pose. Additionally, Studio uses `word.endSec`, while export schedules through `captionWordSegmentEnd`, which can extend to the next word's start. Moving the emoji outside the word entrance fixes one dependency, but does not establish preview/export parity.

**Fix:** Pass the canonical segment window and elapsed media time into the emoji renderer and evaluate the full shared pose, including exit. Preserve the settled pose for reduced motion. Verify playback, pause, seek, short windows and a gap between words; the SSR tests currently check only the entrance's initial markup.

### 4. P2: Packet preroll can activate audio correction for a clean clip window

**Location:** `apps/worker/src/worker-process.ts:331` and `:338`; correction predicate at `apps/worker/src/composition-ffmpeg-adapter.ts:2443`.

**Scenario:** If the probe seek returns packets before the requested interval, the helper detects and retains gaps from that preroll. It does not test whether the missing interval intersects the clip. A controlled probe response with a 400 ms hole ending at source time 0.6 seconds, followed by continuous packets through 3 seconds, returns `atSec: -1.4` for the clean clip from 2 to 3 seconds. Any non-null `audioGaps` enables the resampling branch, changing argv and potentially PCM outside the defect's window. The existing outside-window test covers a hole after the clip, not preroll before it. This reproduction uses an injected response; the local MP4/MKV/TS examples I probed sought closely enough not to trigger it.

**Fix:** Retain only missing intervals that intersect the requested source window before attaching `audioGaps`. Keep boundary context so a hole spanning the clip start is still detected. Add a preroll test asserting the original inspection object and exact command remain unchanged for a wholly earlier hole.

### 5. P3: Studio exposes technical detail without a direct edit action

**Location:** `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/tool-panels/caption-omission-note.tsx:22`.

**Scenario:** The caption panel displays multiple sentences and up to six raw Unicode labels inline. "Edit the text" is prose, with no control that opens or locates the transcript word. This misses the brief's short contextual sentence, one clear action, and popover for details. The clip-row popover already follows that pattern more closely.

**Fix:** Keep a short neutral summary, offer "Edit captions" to open/focus the transcript, and put code points and affected-word context in a popover.

## Checks without findings

- **Security:** Notes render as React text. Skipped emoji are converted to code-point labels, and Home's `from` is checked against own properties of a fixed map. No new HTML, SQL, shell or FFmpeg-expression injection path found through these values.
- **Migration:** The nullable JSONB column is additive, has no backfill/default, and is safe alongside the previous code. Deploy the migration before code that selects the new column.
- **Render completion:** Diagnostics commit with the asset and durable outcome under the existing parent lock. An acknowledgement retry reads the existing outcome instead of overwriting diagnostics. Clean completion clears the column; editor reset also clears it.
- **Folder conflict/receipts:** The database uniqueness constraint remains authoritative. The P2002 conversion throws out of the receipt transaction, so a rejected duplicate records no receipt. A previously accepted key still replays before mutation, and changing the name generates a new browser intent key. Normalization matches between browser and service. Inline field errors and retained focus are appropriate for this blocking validation failure.
- **Home/DV5:** Redirect context is allowlisted, the Home notice is dismissible, and DV5 offers a new upload instead of an ineffective render retry. Copy supplies a next step without exposing provider diagnostics.
- **Probe cost:** There is one additional serial ffprobe per clip render group with audio/facts, rather than per aspect-ratio variant. It is bounded by a 900-second window, 2 MiB captured output, the configured probe deadline of 120 seconds by default, and 64 retained gaps. Ordinary scan failures degrade to header evidence; cancellation and executor health failures propagate. The scan also runs for audio-only audiograms although that builder never calls `alignSourceAudioClock`; skipping that unused scan is a small performance improvement. No measured throughput result is available here.

## Verification evidence and limits

- Ran the focused emoji, glyph coverage, render snapshot and receipt-backed folder tests: **23 passed** across four files.
- Ran the focused web omission, Home notice, folder-name and caption preview tests: **23 passed** across seven files.
- Ran in-memory reproductions for findings 1, 2 and 4. No source/test files were added or changed.
- Read the existing `/tmp/narriflow-golden/candidate-fu/report.md`: **18/18 normal cases identical**, 16 corrected defects passing, two unchanged expected failures. The harness compares argv/filtergraph and decoded PCM hashes; emoji motion has an explicit expected-change entry. This is evidence from the existing run, not a fresh gate run against every subsequent working-tree change.
- Browser check note: no signed-in visual or interaction pass performed. The passing web tests use static rendering and do not verify focus recovery, popover placement, notice dismissal effects or animation clocks. Leave the already-running full gate undisturbed and include these browser checks before declaring the UX verified.

## Resolution (Claude)

All four P2 findings fixed at the root, each with a test that failed first. No disagreement. P3 (finding 5) not touched in this pass.

1. **Indic omission labels.** Root cause was the worker minting unpadded labels (`U+985`) that the persisted schema (`U+XXXX`, 4 to 6 hex digits) rejects. The coverage table was right: the pinned chain has no Bengali, Tamil or Telugu face, so those characters are correctly omitted, and Devanagari (U+0900-097F) is covered. `apps/worker/src/caption-glyphs.ts` now labels both the planner's omissions and the libass-diagnostic failure through the shared `captionCodePointLabel` (the same formatter the Studio uses). Tests: planner output for `U+0985 U+0B85 U+0C05 U+13000` parses through `clipRenderCaptionDiagnosticsSchema`; the libass-line path pads; the services read model keeps all four labels.
2. **Studio omission note.** `studioCaptionOmissionNote(document)` in `apps/web/lib/caption-omissions.ts` now takes the `EditorDocument` and scans `deriveCaptionCues(document)` text, so cuts, censor masks, text transform and hidden captions are honoured. When the preset has an uploaded `fontAsset` it makes no claim, since that font tries each character first and may draw it; the finished render still reports what was left out. Tests include Sol's reproduction (a word cut out is not reported), a full-block mask, and the custom-font case.
3. **Emoji parity.** `CaptionEmoji` takes `elapsedSec` and draws `captionEmojiPose` at that instant, including the 80 ms fade-out and clamping on scrub. `CaptionCue` takes `timeSec`. The overlay passes `currentTime` and each word's window `[word.startSec, captionWordSegmentEnd(layer.words, index)]`, the same window the export schedules, so a gap before the next word is covered. Reduced motion keeps the settled pose. Preset thumbnails have no clock and keep the self-timed entrance. Tests: pose at 0, 100 ms, mid-window, 560 ms of 600 ms (alpha 0.5), a 1.2 s gap window, reduced motion, clamping.
4. **Audio-gap preroll.** `inspectAudioTimestampGaps` keeps only holes whose silence `[atSec - missingSec, atSec]` overlaps the clip window. A wholly earlier or later hole returns null, so the inspection object and argv stay identical. A hole spanning the clip start is still found. The real-file "outside the window" test still passes.

Gates (all local, nothing committed):
- `bun test`: apps/worker 1152 pass, apps/web 985 pass, caption-fonts 38 pass, composition-plan 79 pass.
- `bun run typecheck`: 15/15 tasks successful. `bun run lint`: no errors (11 existing warnings).
- Parity gate: `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-fu2` exited 0; 18/18 normal identical, 16 corrected and passing, 2 expected failures unchanged.
- A first worker `bun test` run made while the golden gate ran concurrently reported 2 failures; a clean rerun was 0 failures (contention, not a code change).
- Browser check not performed: the emoji exit is verified through rendered markup at fixed clock values, not in a live Studio session.
