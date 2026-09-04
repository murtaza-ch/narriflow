/**
 * Escape drawtext content through both FFmpeg parsing levels: first the
 * drawtext option value, then the surrounding filtergraph.
 */
export function escapeDrawtextText(text: string): string {
  const optionLevel = text.replace(/[\\':%]/g, (character) => `\\${character}`);
  return optionLevel.replace(/[\\',;[\]]/g, (character) => `\\${character}`);
}
