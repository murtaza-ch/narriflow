/**
 * How a caption preset card frames its sample. The Studio card and the card renderer
 * (`apps/web/scripts/caption-cards/render.ts`) both read this, so a clip is the card it replaces.
 *
 * Its own module on purpose: the renderer's page must not import the clip manifest, or each manifest write
 * hot-reloads the pages being recorded and spoils their frames.
 */
export const PRESET_CARD_FRAME = { aspectRatio: "4 / 5", backdropFocusYPct: 10, captionTopPct: 66, boost: 1.55 } as const;
