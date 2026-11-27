/**
 * Compiled emoji art, loaded on demand: one dynamic import per shard (a group, or part of a large
 * group), so bundlers split them and Bun reads them from disk.
 */
import type { CaptionEmojiColour } from "./colour";
import { decodeShardColour, type ShardEntry } from "./encoding";
import { SHARD_COUNTS, SHARD_LOADERS } from "./generated/shards";
import { captionEmojiById } from "./index";
import { captionEmojiShardKey } from "./shard-key";

export { CAPTION_EMOJI_BOX, CAPTION_EMOJI_GRID, CAPTION_EMOJI_OUTLINE_GRID } from "./geometry";
export { type CaptionEmojiPathCmd, parseCaptionEmojiPath } from "./path";

export interface CaptionEmojiArtLayer {
  readonly colour: CaptionEmojiColour;
  /** Below 1 when the layer is translucent. */
  readonly alpha?: number;
  /** Path data on the 64 grid, filled with non-zero winding. */
  readonly d: string;
}

export interface CaptionEmojiArt {
  readonly id: string;
  /** Painter order, bottom first. */
  readonly layers: readonly CaptionEmojiArtLayer[];
  /**
   * The union of the layers grown by `CAPTION_EMOJI_OUTLINE_GRID` as one fill: drawn white under the
   * layers, and the one piece that casts the sticker's shadow (a shadow follows only a fill).
   */
  readonly outline: string;
  /** A phrase badge: its main emoji is drawn at 0.74 of the box with a second one in a disc at its corner. */
  readonly badge: boolean;
}

const shards = new Map<string, Promise<Record<string, ShardEntry>>>();
const decoded = new Map<string, CaptionEmojiArt>();

function loadShard(key: string): Promise<Record<string, ShardEntry>> {
  let shard = shards.get(key);
  if (!shard) {
    const loader = SHARD_LOADERS[key];
    if (!loader) throw new Error(`no emoji shard ${key}`);
    shard = loader().then((module) => JSON.parse(module.default) as Record<string, ShardEntry>);
    shard.catch(() => shards.delete(key));
    shards.set(key, shard);
  }
  return shard;
}

/**
 * The art for each known id; unknown ids are left out of the map, and so are the ids of a shard
 * that failed to load (each shard settles on its own, and a failed one is asked again next time).
 */
export async function loadCaptionEmojiArt(ids: Iterable<string>): Promise<Map<string, CaptionEmojiArt>> {
  return (await loadCaptionEmojiArtSettled(ids)).art;
}

/**
 * `loadCaptionEmojiArt`, and which ids were left out because their shard failed to load (`failed`): a
 * cache keeps those to ask again, and treats the other missing ids (not in the catalog) as answered.
 */
export async function loadCaptionEmojiArtSettled(ids: Iterable<string>): Promise<{ readonly art: Map<string, CaptionEmojiArt>; readonly failed: ReadonlySet<string> }> {
  const wanted = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const entry = captionEmojiById(id);
    if (!entry) continue;
    const key = captionEmojiShardKey(id, entry.group, SHARD_COUNTS[entry.group] ?? 1);
    wanted.set(key, [...(wanted.get(key) ?? []), id]);
  }
  const result = new Map<string, CaptionEmojiArt>();
  const failed = new Set<string>();
  await Promise.allSettled(
    [...wanted].map(async ([key, shardIds]) => {
      let shard: Record<string, ShardEntry>;
      try {
        shard = await loadShard(key);
      } catch (error) {
        for (const id of shardIds) failed.add(id);
        throw error;
      }
      for (const id of shardIds) {
        let art = decoded.get(id);
        if (!art) {
          const entry = shard[id];
          if (!entry) continue;
          art = Object.freeze({
            id,
            outline: entry[0],
            badge: captionEmojiById(id)?.kind === "phrase",
            layers: Object.freeze(
              entry[1].map(([colour, d, alpha]) =>
                Object.freeze(alpha === undefined ? { colour: decodeShardColour(colour), d } : { colour: decodeShardColour(colour), alpha, d }),
              ),
            ),
          });
          decoded.set(id, art);
        }
        result.set(id, art);
      }
    }),
  );
  return { art: result, failed };
}
