import type { CaptionEmojiColour, CaptionEmojiRole } from "./colour";

/** A layer in a shard: colour (role name, `#rrggbb`, or a per-tone list), path data, alpha. */
export type ShardLayer = [string | (string | null)[], string] | [string | (string | null)[], string, number];
/** A design in a shard: outline path data, then layers in painter order. */
export type ShardEntry = [string, ShardLayer[]];

export interface EncodableArt {
  layers: readonly { colour: CaptionEmojiColour; alpha?: number; d: string }[];
  outline: string;
}

export function encodeShardEntry(art: EncodableArt): ShardEntry {
  const layers = art.layers.map((layer): ShardLayer => {
    const colour = "role" in layer.colour ? layer.colour.role : "hex" in layer.colour ? layer.colour.hex : [...layer.colour.tone];
    return layer.alpha === undefined ? [colour, layer.d] : [colour, layer.d, layer.alpha];
  });
  return [art.outline, layers];
}

export function decodeShardColour(code: string | (string | null)[]): CaptionEmojiColour {
  if (Array.isArray(code)) return { tone: code };
  if (code.startsWith("#")) return { hex: code };
  return { role: code as CaptionEmojiRole };
}
