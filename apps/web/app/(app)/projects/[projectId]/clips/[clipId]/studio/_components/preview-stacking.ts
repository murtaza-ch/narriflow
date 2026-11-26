/**
 * The preview's stacking order, one number per canvas object, in the composition plan's visual
 * order (`zIndex` on the plan's layers: B-roll 20, inserted scene 25, text 30, captions 40, logo 50,
 * transition 60, output treatment 70), so the Studio stacks what the export burns. Interactive
 * extras sit above the picture: a selected text layer's frame and grips over everything drawn (the
 * logo, transition and watermark take no pointer), status and snap guides on top.
 */
export const PREVIEW_Z = {
  /** Video B-roll (its own element over the source layers). */
  videoBroll: 3,
  imageBroll: 20,
  insertedScene: 24,
  text: 30,
  caption: 40,
  captionEmoji: 41,
  captionFrame: 42,
  logo: 50,
  transition: 60,
  watermark: 70,
  /** The selected text layer's frame and grips. */
  textFrame: 75,
  status: 80,
  snapGuides: 90,
} as const;
