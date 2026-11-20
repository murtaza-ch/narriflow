/**
 * Library artwork: a gradient derived from the asset id alone, so every row
 * has a stable cover with no network request. The palette is a ring of deep,
 * slightly muted hues that sit on the graphite Studio; a cover blends two
 * neighbours, so it never pairs clashing colors.
 */
const PALETTE = [
  ["#E0913A", "#6B3A12"], // amber
  ["#D2638A", "#5A1F37"], // rose
  ["#8A63EA", "#2E1D6E"], // violet
  ["#6573D4", "#232B5E"], // indigo
  ["#4A78E8", "#1B2F73"], // blue
  ["#1F9DB3", "#0B3F4C"], // teal
  ["#3AA987", "#134536"], // jade
  ["#7B879B", "#2A313D"], // slate
] as const;

const ANGLES = [125, 145, 165, 205, 225, 245] as const;

/** FNV-1a, 32 bit: tiny, stable across runtimes, and spreads UUIDs evenly. */
export function hashAudioAssetId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface AudioArt {
  angle: number;
  from: string;
  to: string;
  /** A CSS `background` value. */
  background: string;
}

export function audioArt(id: string): AudioArt {
  const hash = hashAudioAssetId(id);
  const first = hash % PALETTE.length;
  // The neighbour one or two steps along the ring, never the same hue.
  const second = (first + 1 + ((hash >>> 8) % 2)) % PALETTE.length;
  const angle = ANGLES[(hash >>> 16) % ANGLES.length] ?? ANGLES[0];
  const from = PALETTE[first]?.[0] ?? PALETTE[0][0];
  const to = PALETTE[second]?.[1] ?? PALETTE[0][1];
  return { angle, from, to, background: `linear-gradient(${angle}deg, ${from}, ${to})` };
}

export const AUDIO_ART_COLORS: readonly string[] = PALETTE.flat();
