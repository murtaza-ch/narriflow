/**
 * Escape a filter option value through both FFmpeg parsing levels: first the
 * option value, then the surrounding filtergraph.
 */
export function escapeFilterOptionValue(value: string): string {
  const optionLevel = value.replace(/[\\':]/g, (character) => `\\${character}`);
  return optionLevel.replace(/[\\',;[\]]/g, (character) => `\\${character}`);
}

/**
 * Drawtext options that draw `text` exactly as written. Drawtext otherwise
 * parses the text a third time for `%{...}` expansions, which turns a plain
 * `%` or `\` in user text into an error or a blank frame.
 */
export function drawtextLiteralText(text: string): string {
  return `text=${escapeFilterOptionValue(text)}:expansion=none`;
}
