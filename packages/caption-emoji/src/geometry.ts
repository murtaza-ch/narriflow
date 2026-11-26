/** Every design is drawn on a 64 by 64 grid (the pack's viewBox). */
export const CAPTION_EMOJI_GRID = 64;

/** How far the sticker outline reaches past the art, in grid units. */
export const CAPTION_EMOJI_OUTLINE_GRID = 2.2;

/**
 * A hole in the art (heart hands, a chain link, a safety pin) stays open in the sticker outline
 * when, after the outline has grown into it, it still holds a disc of this radius, grid units.
 * Smaller holes are filled: the hard shadow (about 2.6 units down and right) would cover most of
 * them and they would read as dark specks or rings.
 */
export const CAPTION_EMOJI_KEPT_HOLE_GRID = 4;

/**
 * The one drawing box, in grid units, that holds every point of every design's layers,
 * and outline, control points included. Renderers draw every piece of an emoji in this
 * box so all of its layers scale and turn about one point, the grid's centre.
 */
export const CAPTION_EMOJI_BOX = Object.freeze({ x: -2.3, y: -2.3, width: 68.6, height: 68.6 });
