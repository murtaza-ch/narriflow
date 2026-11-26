# 07 - Title on project page clip cards

**What to build:** A clip card that plays the preview proxy shows the clip's title over the video, as the Studio and the export would.

**Blocked by:** [03 - Studio canvas](03-studio-canvas.md), [05 - Auto title and persistence](05-auto-title-and-persistence.md)

**Status:** done (2026-11-27)

Read `../spec.md` section 8. Reference: `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-b901fa49-8bcd-4220-aa83-a52132bfb637.png`.

## Scope

- The clips list response carries each clip's title layer (the first `role: "title"` layer only, not the whole document) and what the overlay needs to map player time to edited time.
- `clip-row.tsx` / `clip-video.tsx`: when the card shows the proxy for the selected format, paint the layer with the scene painter scaled to the video rectangle; visible on the first frame when active there; follows play, pause, seek and replay; hidden when a finished render plays (it is burned in).
- Keep the project page's load cost flat: no extra request per card, fonts load only when a card has a title.

## Acceptance

- [x] A card with a title shows it behind the play button and for the layer's active range during playback.
- [x] A card playing a finished render shows no overlay.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check` pass.

## Evidence (2026-11-27)

Branch `feat/title-text-cards` (from `feat/title-text` 806635411).

- Response shape: the first-party clips list (`GET /api/projects/:id/clips`, also the project read model) already carried `studioEdits`, so the card already had the title layer (`findTitleLayer(clip.studioEdits.textLayers)`); no second copy of it was added. The one missing piece was the cut list: `clipSnapshotSchema` gains `deletedRanges` (optional array of source ranges), filled from the decoded editor document in `toClipSnapshot`. The column was already in `clipSnapshotSelect`, so no query changed. The route is not in REST v1 or the OpenAPI document (`openapi:check` unchanged).
- Mapping (`clip-title-overlay-model.ts`): the proxy plays the clip's source window straight through, cuts included. Player seconds + `previewStartSec` = source seconds, then `sourceToEdited` on `buildClipCutPlan(deletedRanges, window).map`, the plan's own map. Inside a cut the time is the next kept frame's. The layer's window is clamped to the edited duration as the composition plan clamps it. Inserted Scene Blocks are not in the proxy and do not move a layer's base time, so they play no part.
- Painting (`clip-title-overlay.tsx`): `useTextLayerScene` (built once per layer and format canvas, after its faces load) and `CaptionSceneLayers` at `cardWidth / canvas.width`, as the Studio does. The canvas is the selected format's (`clipAspectRatioOptions` width × height), the box is the card's media well. Nothing was copied; `useElementWidth` in `text-layer-sample.tsx` is now exported for it.
- Clock (`createPlayerClock` in `clip-video.tsx`): media events (loaded, seeked, time update, pause, the end-of-clip rewind) notify, and while playing one animation frame loop notifies, only while an overlay listens. The overlay mounts with the row's lazy load (near the viewport).
- Cost: the overlay module (painter + caption scene) is loaded by `next/dynamic` only for a card that shows the proxy and has a title; faces load on demand from the layer's own glyphs. No request per card.
- Hidden on a finished render: `clip-row.tsx` builds the model only when the preview descriptor says `isPreviewProxy`.
- Tests: `clip-title-overlay-model.test.ts` (3: first title layer only, offset and cut mapping, clamping); `clip-video.browser.fixture.tsx` (+2: the overlay clock through load, seek, time update and the rewind; what the card hands the painter: layer, window, canvas, scale 270/1080, edited time after a cut, no rebuild on re-render).
- Real browser (temporary prototype page with `public/caption-cards/arthouse.mp4` as the proxy, offset 100 s, clip 100.2–107.5 with 102–103 cut; deleted before commit). Headless Chrome over CDP in real time (virtual-time seeks were unreliable):
  - `cards/cards-at0.png`: first frame. Title behind the play button on 9:16, 1:1 and 16:9; none on the card whose title starts at 2 s; none on the finished-render card.
  - `cards/cards-at3.5.png`: edited 2.5 s. All four proxy titles drawn, still none on the render card.
  - `cards/cards-at6.5.png`: edited 5.5 s. All hidden.
  - Playback from player 3.7 s to 6.9 s, sampled every animation frame: drawn until 6.18 s, hidden from 6.20 s. Edited 5.0 s is source 106.2 s (103 + 3.2), player 6.2 s.
- Not verified: a signed-in project page against real data.
- Verification: `bun run lint` (0 errors; the same 20 warnings as ticket 05, none in these files), `bun run typecheck` (17/17), `bun run check:web-split` (passed), `test:inventory` (302 routes, 0 problems), `openapi:check` (32 operations match), `build:worker` (audit passed). `bun run test`: web 1496, api 994, api-client 242, validators 1392, services 3283 run, 0 fail. The first run had one services timeout: the 600,000-iteration PBKDF2 passcode test took 5,021 ms against a 5 s limit on a loaded machine; the file passes alone (13/13) and in the rerun. Media: 4 environment failures (`apps/media/models/face_yunet.onnx` is not in a fresh worktree (2 tests), a memory sampling assertion and a 5.4 s timeout under load); media does not read the clip snapshot.
