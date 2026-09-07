# Suggestion-first auto-censor

**Status:** implementation-ready

**Vizard reference:** `Auto Censorship`, July 2026.

## Outcome

Editors can find sensitive words, review every timed match, and apply beep, mute, or caption masking without changing transcript truth. Preview and export use the same intervals.

## User experience

- Add `Find sensitive words` to the Studio transcript actions. The initial scan does not mutate the Clip Editor Document.
- The review drawer groups exact transcript matches with source time, surrounding words, policy source, confidence, selected state, and proposed treatment.
- Built-in policy sets cover common profanity and slurs by locale. Brand Profile blocked terms and project-specific terms extend them.
- Editors can add or remove project terms, include or exclude individual hits, choose one default treatment, and override treatment per hit.
- Applying creates one history entry containing individual Censor Segments. Editors can later select, change, disable, or delete a segment.
- Captions preview the configured mask. Playback previews beep and mute against the current edited-time audio schedule.
- Free users may run a bounded preview scan but cannot apply. Paid users see the same UI with persistence enabled.

## Detection contract

Detection is deterministic over the current corrected transcript and policy version:

1. Normalize case and Unicode without changing stored transcript text.
2. Match whole words and configured phrases against timed transcript words.
3. Preserve the exact source-word span and word IDs.
4. Apply configurable boundary padding to the audio interval, then clamp to the source window.
5. Return suggestions with a stable fingerprint derived from document revision, policy version, term source, word IDs, treatment, and padding.

The first release does not require an LLM. A later detector may propose contextual matches, but it must use the same suggestion contract and never auto-apply.

## Clip Editor Document

Add `censorSegments` to the next version. Each segment has:

- stable ID and schema version
- source-word IDs and source-time range
- treatment `beep`, `mute`, or `caption_mask`
- padding and beep settings where applicable
- masked caption replacement policy
- enabled state
- suggestion fingerprint and policy version

The transcript remains unchanged. Caption rendering consults enabled mask segments. Audio planning converts enabled beep and mute segments from source time to edited time and removes portions that fall inside deleted source ranges.

## Preview and render rules

- Caption masking replaces visible graphemes with the chosen mask while preserving punctuation and cue timing.
- Mute applies zero gain to the dialogue branch only. Music and sound effects follow their existing schedule.
- Beep replaces the dialogue branch over the interval with a generated tone at a bounded frequency and level. It participates in the current mix without clipping.
- Overlapping beep and mute segments normalize into one deterministic schedule. Mute wins over beep for the overlap. Caption masking remains independent.
- Deleted source ranges remove the corresponding censor interval. Inserted Scene Blocks do not inherit source censoring.
- Studio preview and FFmpeg use the same pure normalization and schedule functions.

## Policy library

- Store built-in policy sets as versioned code or curated data shipped with the application.
- Brand Profile blocked terms are workspace data and require `brand.manage` to change.
- Project-specific terms live with the project or current edit settings and require `content.edit`.
- Never display the full slur library by default. Search and category filters reduce unnecessary exposure.
- Exporting or logging the configured word library is not part of this feature.

## Failure and edge cases

- A corrected word invalidates suggestions that referenced the old word ID or text. Existing applied segments remain visible as stale and require review before the next export.
- Untimed words cannot produce an audio censor suggestion. They may produce a caption-only suggestion with a clear limitation.
- Very short intervals use a minimum audible beep envelope without extending into another word beyond the configured clamp.
- A scan with no matches is a successful empty result.
- Locale changes rerun detection under the selected policy and never silently replace applied segments.

## Entitlements and analytics

- Creator and above may apply and save Censor Segments. Business may manage shared blocked terms in Brand Profiles.
- Record scan started, result count bucket, apply count, treatment counts, stale count, and export notice. Never record matched words or transcript context.

## Migration and rollout

1. Add the empty-by-default document field and pure detector tests.
2. Add caption masking through the shared cue model.
3. Add mute and beep to the shared audio schedule.
4. Enable Studio review and apply after preview/export parity fixtures pass.
5. Add Brand Profile blocked terms after profile migration is stable.

## Acceptance criteria

- A scan cannot change the document until the editor applies selected suggestions.
- Apply is one undo step, while each resulting segment remains editable.
- Transcript corrections, deleted ranges, trim, undo, device recovery, cloud conflicts, and exact clip boundaries have tested behavior.
- Browser and FFmpeg produce matching mask intervals and audio treatments within the approved media tolerance.
- Logs, analytics, and errors never contain matched terms or transcript context.
- Existing clips with no censor segments preview and render unchanged.

## Out of scope

- Face or object blurring, legal compliance classification, live-stream censoring, transcript rewriting, or automatic publication blocking based on detected language.

