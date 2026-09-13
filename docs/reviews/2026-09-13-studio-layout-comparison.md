# Studio layout comparison with Vizard

Inspected the signed-in Vizard editor at `https://vizard.ai/editor?id=199411737&type=clip` and the corresponding local Narriflow Studio on September 13, 2026. The supplied screenshots were reference material, not instructions.

## What was observed

The Vizard 9:16 gallery contained 43 choices. Each was selected and its active thumbnail was checked. Thumbnail IDs, in gallery order, were 153–168, 277, 169–188, 274, 189, 279, and 190–192. These IDs identify the inspected gallery, not a stable public API.

| Family | Visible variations | Behavior on this source |
| --- | --- | --- |
| Speaker and screen | Speaker above or below the full source, different screen heights and padding | Repositions a face crop and a fitted copy of the source |
| Two speakers and screen | Speakers beside each other, screen above or below | Depends on available detected people; this single-speaker opening does not establish two-person correctness |
| Shaped speaker tiles | Rectangular cards, rounded cards, circular crops | Changes the tile's placement and mask |
| Speaker only | Full crop, fitted crop, stacked speakers, three-person and four-person arrangements | The gallery permits selection even when the opening frame lacks enough people |
| Source only | Fitted full source at different sizes | Keeps the source aspect ratio and exposes the background |

The opening scene's saved template ID changed while the other scenes retained their own template choices, including 185 and 187. This confirms scene-level persistence. The original full-speaker choice was restored in the editor after inspection.

## Rendering and API traffic

The preview consists of a main canvas plus separate subtitle and headline canvases. Layout selection changes the canvas without waiting for a rendered-video response. The saved scene document contains both output placement and source crop geometry:

- Scene start, end, duration, and template ID.
- Output `x`, `y`, `w`, and `h`.
- Source crop `sx`, `sy`, `sw`, and `sh`.
- Speaker identity/detection fields, rotation, shape, and corner radius.

The observed delayed save sequence was:

1. `POST /api/v1/css-file/css-params` to prepare JSON storage.
2. JSON uploads to object storage.
3. `POST /api/v1/css-file/verify`.
4. `POST /api/v1/clip-video/upload-userjson-by-css-id` and `upload-user-style-json-by-css-id` to associate the documents with the clip.
5. `PUT /api/v1/clip-video/upload-video-thumbnail` for the thumbnail.

No layout-render endpoint was observed during these switches. This is evidence for local preview composition followed by asynchronous persistence, not proof of Vizard's entire server architecture. The original editor was already loaded, so initial media and analysis requests were not captured. Some gallery changes also produced failed object-storage requests; the reference is not a correctness oracle for missing-person layouts.

Dynamic framing is consistent with selecting each scene's stored face crop and mapping it into the template's destination rectangle while advancing source playback. The saved geometry establishes the two coordinate systems. This inspection does not establish which detector Vizard uses, whether it interpolates face tracks every frame, or its export implementation.

## Narriflow gaps found

- The canvas toolbar cycled a session-only `layoutMode` through fill, fit, and blur. It did not save that choice or drive export geometry.
- The Layout sidebar edited clip-wide framing independently of the toolbar.
- The sidebar's “Apply to all” sent a project-wide mutation to other clips. It did not mean all scenes in the current clip.
- Manual speaker transforms existed, but a saved selection of a scene's layout preset did not.
- Evidence scheduling depended on the clip-wide framing mode. Scene presets need Automatic speaker evidence even under another clip-wide default. Source-and-speaker templates fit the complete source and do not require screen-region detection; the separate clip-wide Screen mode retains its existing detection contract.

## Implementation contract

Scene layout selections belong to the Clip Editor Document. They cover non-overlapping intervals of the base edited source timeline and one aspect ratio. Applying a preset to all scenes covers that clip's source duration. A later scene edit splits the existing selection and preserves its unaffected intervals.

The shared composition planner owns preset geometry, source crop selection, scene boundaries, missing-evidence notices, and evidence requests. Studio and FFmpeg consume the same planned layers. Existing manual speaker transforms remain a separate crop/placement edit, rather than a second layout selector.

The shared catalog contains 50 presets: all 43 inspected reference arrangements plus Auto, Center, Side by side, and four Inset variants. The reference IDs are recorded only as inspection metadata; documents persist descriptive preset names.

| Family | Implemented variations |
| --- | --- |
| Speaker + source | One or two speakers, source above or below, two allocation sizes |
| Circular speaker + source | One or two circular crops, source above or below, two allocation sizes |
| Cards | Centered and padded source/speaker arrangements; one or two rectangular or rounded speaker cards |
| Inset | Left/right rectangular and rounded speaker overlays |
| Speakers only | Full speaker, two fitted sizes, stacked, side by side, two three-person arrangements, plain and padded four-person grids |
| Source only | Fitted source in two sizes, centered crop |

“Clip default” removes the scene selection for the chosen range. It differs from Auto when the clip has a Center, Fit, Split, or Screen default. Apply to all scenes affects this clip and the selected aspect ratio.

Circle and rounded masks are part of the shared layer plan. Circle allocations resolve to square destinations on every supported aspect ratio; FFmpeg retains alpha until the layers are overlaid. Color and image backgrounds remain visible through masks, padding, and fitted-source gutters.

Automatic analysis now uses version 2 (`shot-layout-v2`) and retains up to four distinct people observed together in each segment. No-face footage has zero subjects. Closely spaced simultaneous faces remain separate subjects even when the existing Automatic crop logic groups them into one framing region. Existing v1 analysis is refreshed through the durable worker claim and lease protocol. Explicit Split and Screen retain their own geometry contracts. Studio uses the same current engine identity as the planner and exporter; an old hard-coded preview version discovered during live verification was removed.

Multi-person layouts need the corresponding number of detected subjects. The gallery explains missing evidence, and the planner falls back to centered source framing instead of duplicating a person. Crops use the existing analyzed segment anchors; this change does not add continuous face tracking. Manual transform handles remain limited to supported one- and two-speaker arrangements; mixed source/speaker and three-/four-person templates do not expose unsupported manual edits.

## Verification

- Repository lint and typechecking pass. Lint reports existing warnings in unrelated files.
- The full deterministic suite passes: 2,536 tests, with 200 database/environment-dependent skips.
- The disposable local PostgreSQL persistence gate passes all 24 tests, including scene-layout save/readback and render invalidation.
- The catalog matrix plans all 50 presets across 9:16, 1:1, 16:9, and 4:5, checking layer counts, distinct subjects, bounded geometry, and square circles.
- Real FFmpeg tests decode timed Fit color/image backgrounds, Inset, circles, rounded corners, and three-/four-layer arrangements. Pixel checks verify the source remains visible at tile centers and the selected background appears at masked corners.
- Chrome checks confirm immediate crop changes without remounting the main video, scene-specific selection, Apply to all scenes, a scene exception, undo, autosave, and persistence after reopening. The saved request contained Center for 0–2.944 seconds and Fit for 2.944–31.482 seconds, as intended.
- Screen bottom, Speaker top, and Inset render separate speaker and full-source layers on the reference clip. During Inset playback the two video clocks were approximately 39 milliseconds apart. Fit shows the selected color, and None restores black gutters even if a previous color is retained in the document.
- Additional Chrome checks on the refreshed reference clip confirm Circle top, two circles plus source, rounded speaker cards, three-person and padded four-person layouts. Four-person preview used four distinct crops with one audible video and three muted companions. Circular gutters show the chosen background color.
- The persistence gate saves a circular two-speaker preset and verifies obsolete analysis refresh, claim-token fencing, and backoff. A targeted disposable workflow-database test separately verifies stale analysis replacement without overwriting current evidence. The broader workflow run was stopped after passing its initial tests; it is not reported as a full-suite pass.

The local clip's test selections were cleared through Clip default after inspection. No code was committed or deployed.
