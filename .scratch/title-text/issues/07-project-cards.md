# 07 - Title on project page clip cards

**What to build:** A clip card that plays the preview proxy shows the clip's title over the video, as the Studio and the export would.

**Blocked by:** [03 - Studio canvas](03-studio-canvas.md), [05 - Auto title and persistence](05-auto-title-and-persistence.md)

**Status:** ready-for-agent

Read `../spec.md` section 8. Reference: `/Users/murtaza/.t3/userdata/attachments/2358ee32-8fcd-4fd7-88f7-f7b95689bc87-b901fa49-8bcd-4220-aa83-a52132bfb637.png`.

## Scope

- The clips list response carries each clip's title layer (the first `role: "title"` layer only, not the whole document) and what the overlay needs to map player time to edited time.
- `clip-row.tsx` / `clip-video.tsx`: when the card shows the proxy for the selected format, paint the layer with the scene painter scaled to the video rectangle; visible on the first frame when active there; follows play, pause, seek and replay; hidden when a finished render plays (it is burned in).
- Keep the project page's load cost flat: no extra request per card, fonts load only when a card has a title.

## Acceptance

- [ ] A card with a title shows it behind the play button and for the layer's active range during playback.
- [ ] A card playing a finished render shows no overlay.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, `bun run check:web-split`, `bun run --cwd apps/api test:inventory`, `bun run --cwd apps/api openapi:check` pass.
