# Reusable and insertable scene blocks

**Status:** implementation-ready

**Vizard reference:** `Subtitle line editing and scene insertions with bulk intro automation`, 22 June 2026.

## Outcome

Editors can add a hook, intro, outro, image card, color card, or text card without leaving Studio. Agencies can save a scene as a Brand Profile template and apply it to selected clips.

## Scope and editor behavior

- A Scene Block occupies edited time and contains exactly one primary visual kind: video, image, color card, or text card.
- Insert at the start, end, or current playhead. The transcript offers the same insert action at a selected word boundary.
- Video scenes support source range, duration, fit, background, source-audio volume, and mute.
- Image scenes support duration, fit, background, and media animation.
- Color and text cards support duration, background, bounded text fields, typography from the active brand, and media animation.
- Editors may move a Scene Block to another valid edited-time boundary, trim its duration within type limits, duplicate it, replace its asset, or delete it.
- Intro and outro Scene Templates can be applied from Brand Kit or through Campaign Operations. Applying a template copies its frozen definition into each target Clip Editor Document.
- Changing a Scene Template later does not change clips that already used it.

This is not a multi-track editor. Scene Blocks do not overlap one another, nest, contain arbitrary layer stacks, or create alternate timelines.

## Document and composition contract

Extend the next Clip Editor Document version with `sceneBlocks`. Each block has:

- stable ID and schema version
- insertion anchor in edited time
- visual kind and durable asset reference where required
- source range for video
- duration and fit treatment
- background treatment
- bounded text payload for text cards
- source-audio treatment
- media-motion settings
- optional origin Scene Template ID and frozen template fingerprint

The document stores durable asset IDs and fingerprints, not signed URLs. The Studio Editing Session owns insertion, move, trim, duplicate, delete, history, local durability, cloud checkpoints, and conflicts.

The Clip Composition Plan owns the resolved scene sequence. It maps source content and inserted blocks into one contiguous edited-time plan, resolves target canvases, produces notices for optional degradation, and supplies the same result to browser and FFmpeg adapters.

## Timing rules

- An insertion increases edited duration. The source-media time map remains unchanged outside the inserted interval.
- A Scene Block anchor refers to an edited boundary derived from the document state at the time of the edit. The reducer deterministically remaps later anchors after insert, move, trim, delete, undo, and redo.
- A video scene cannot reference outside its Visual Asset duration.
- Image, color, and text cards default to three seconds. The allowed range is one to thirty seconds.
- Video blocks default to their selected range and use the existing clip duration ceiling for the resulting document.
- Transcript captions, source B-roll cues, and source audio pause while a fully inserted Scene Block is active. A video Scene Block may play its own audio.
- Existing deleted source ranges stay deleted and do not shift in source time.

## Brand templates and bulk application

- A Scene Template stores a validated Scene Block definition with reusable asset and font references.
- A profile may mark one default intro and one default outro.
- Project creation may offer those defaults but does not silently add them unless the user selected an automation rule.
- Campaign bulk application takes selected clips, expected editor revisions, a Scene Template fingerprint, and placement. Each clip returns applied, unchanged, stale, ineligible, or failed.
- Reapplying the same template fingerprint at the same placement is idempotent.

## Asset and failure behavior

- A missing optional image or video produces a composition notice and blocks new export of that affected clip until the editor replaces or removes the Scene Block. Existing exports remain downloadable.
- A deleted reusable asset remains resolvable for already-frozen Scene Blocks while the backing object is retained. Hard deletion waits until no live scene or template reference remains.
- Unsupported video codec, invalid duration, or missing font is rejected before insertion.
- If one selected clip would exceed duration or document-size limits, that item fails without rolling back eligible items.

## Entitlements and analytics

- Creator and above may insert one-off Scene Blocks and use personal Scene Templates.
- Pro adds selection-scoped template application.
- Business adds shared Scene Templates and default intro or outro governance.
- Record scene inserted, scene removed, template saved, template applied, and batch outcome with type, duration bucket, placement, and IDs only.

## Migration and rollout

1. Land the empty-by-default editor-document version and migration tests.
2. Extend the Clip Composition Plan after its timed visual-layer ticket is complete.
3. Shadow plan output for documents without Scene Blocks to prove no change.
4. Enable color and text cards, then images, then uploaded video.
5. Enable Scene Templates and selection-scoped application after single-clip parity is stable.

## Acceptance criteria

- Old editor documents upgrade to an empty Scene Block list and render byte-compatible output where the current render contract requires it.
- Insert, move, trim, duplicate, delete, undo, redo, local recovery, cloud conflict, and export preparation run through the Studio Editing Session.
- Studio and FFmpeg show the same duration, scene boundaries, fit, text, audio, and motion for every supported aspect ratio.
- Intro and outro bulk application is idempotent and reports stale or ineligible clips individually.
- Missing assets, font fallback, deleted source ranges, exact clip end, and downgrade behavior have focused tests.

## Out of scope

- Overlapping scenes, nested sequences, arbitrary tracks, scene-specific captions over source dialogue, or collaborative live editing.
- Automatic narrative rewriting or automatic scene generation.
- Replacing the existing source-media trim and deleted-range model.

