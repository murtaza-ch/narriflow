import {
  MUSIC_BLOCK_MIN_DURATION_SEC,
  STUDIO_EDIT_LIMITS,
  type StudioMusicBlock,
} from "@narriflow/validators";

/**
 * Pure geometry for the Studio's music lane. Every function takes and returns
 * EDITED-timeline seconds (the unit `StudioMusicBlock` stores), never pixels
 * or composite time, so the timeline, the keyboard shortcuts and the music
 * panel share one set of rules and none of them needs a DOM to be tested.
 *
 * The rules, in one place:
 *  - Blocks are kept in timeline order and never overlap.
 *  - A move or trim clamps to the neighbours and the clip; it never truncates
 *    a block and never reverts a drop.
 *  - Only the last block may run to the clip end (`endSec: null`).
 */

export const MUSIC_MIN_SEC = MUSIC_BLOCK_MIN_DURATION_SEC;
export const MUSIC_DEFAULT_VOLUME = 35;

const EPSILON = 1e-6;

export type MusicTrack = Pick<StudioMusicBlock, "assetId" | "url" | "title">;

/** Where a block stops: its own end, capped at the clip end. */
export function blockEndSec(block: StudioMusicBlock, clipDurationSec: number): number {
  return Math.min(block.endSec ?? clipDurationSec, clipDurationSec);
}

export function blockDurationSec(block: StudioMusicBlock, clipDurationSec: number): number {
  return Math.max(0, blockEndSec(block, clipDurationSec) - block.startSec);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The free room around one block: the previous block's end and the next block's start. */
export function blockBounds(
  blocks: readonly StudioMusicBlock[],
  id: string,
  clipDurationSec: number,
): { prevEndSec: number; nextStartSec: number } | null {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0) return null;
  const previous = blocks[index - 1];
  const next = blocks[index + 1];
  return {
    prevEndSec: previous ? blockEndSec(previous, clipDurationSec) : 0,
    nextStartSec: next ? next.startSec : clipDurationSec,
  };
}

/** The block under a time, half-open so a shared edge belongs to the later block. */
export function blockAtTime(
  blocks: readonly StudioMusicBlock[],
  timeSec: number,
  clipDurationSec: number,
): StudioMusicBlock | null {
  return (
    blocks.find(
      (block) => timeSec >= block.startSec && timeSec < blockEndSec(block, clipDurationSec),
    ) ?? null
  );
}

/** The selected block, or the only block when exactly one exists. */
export function selectedOrOnlyBlock(
  blocks: readonly StudioMusicBlock[],
  selectedId: string | null,
): StudioMusicBlock | null {
  const selected = selectedId ? blocks.find((block) => block.id === selectedId) : undefined;
  if (selected) return selected;
  return blocks.length === 1 ? (blocks[0] ?? null) : null;
}

export function patchMusicBlock(
  blocks: readonly StudioMusicBlock[],
  id: string,
  patch: Partial<StudioMusicBlock>,
): StudioMusicBlock[] {
  return blocks.map((block) => (block.id === id ? { ...block, ...patch } : block));
}

// ── Snapping ────────────────────────────────────────────────────────────────

export interface SnapConfig {
  readonly targetsSec: readonly number[];
  readonly thresholdSec: number;
}

/** Times a dragged edge snaps to: 0, the clip end, the playhead and every other block's edges. */
export function snapTargets(
  blocks: readonly StudioMusicBlock[],
  excludeId: string,
  playheadSec: number,
  clipDurationSec: number,
): number[] {
  const targets = [0, clipDurationSec, playheadSec];
  for (const block of blocks) {
    if (block.id === excludeId) continue;
    targets.push(block.startSec, blockEndSec(block, clipDurationSec));
  }
  return targets.filter((target) => Number.isFinite(target));
}

/** The nearest target within the threshold, or null. */
export function nearestSnap(
  valueSec: number,
  snap: SnapConfig | null | undefined,
): number | null {
  if (!snap) return null;
  let best: number | null = null;
  let bestDistance = snap.thresholdSec;
  for (const target of snap.targetsSec) {
    const distance = Math.abs(target - valueSec);
    if (distance <= bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

// ── Move ────────────────────────────────────────────────────────────────────

export interface MusicMoveResult {
  startSec: number;
  endSec: number | null;
  /** The target the block snapped to, for the guide line; null when nothing snapped. */
  guideSec: number | null;
}

/**
 * Moves a block, keeping its length. The start is clamped between the
 * previous block's end and the room before the next block / clip end, so a
 * drop past a neighbour or the clip end lands against it instead of cutting
 * the block or snapping back.
 */
export function moveBlock(
  blocks: readonly StudioMusicBlock[],
  id: string,
  desiredStartSec: number,
  clipDurationSec: number,
  snap?: SnapConfig | null,
): MusicMoveResult | null {
  const block = blocks.find((candidate) => candidate.id === id);
  const bounds = blockBounds(blocks, id, clipDurationSec);
  if (!block || !bounds) return null;

  const length = blockDurationSec(block, clipDurationSec);
  const unchanged: MusicMoveResult = {
    startSec: block.startSec,
    endSec: block.endSec,
    guideSec: null,
  };
  const min = bounds.prevEndSec;
  const max = bounds.nextStartSec - length;
  if (max < min - EPSILON) return unchanged;

  // Whichever edge is closer to a target wins.
  let candidate = desiredStartSec;
  let snappedEdge: "start" | "end" | null = null;
  let snapTarget = 0;
  const startSnap = nearestSnap(desiredStartSec, snap);
  const endSnap = nearestSnap(desiredStartSec + length, snap);
  const startDistance = startSnap === null ? Infinity : Math.abs(startSnap - desiredStartSec);
  const endDistance = endSnap === null ? Infinity : Math.abs(endSnap - (desiredStartSec + length));
  if (startSnap !== null && startDistance <= endDistance) {
    candidate = startSnap;
    snappedEdge = "start";
    snapTarget = startSnap;
  } else if (endSnap !== null) {
    candidate = endSnap - length;
    snappedEdge = "end";
    snapTarget = endSnap;
  }

  const startSec = clamp(candidate, min, Math.max(min, max));
  // `startSec + length` can land one ulp past the next block's start when the
  // block is dropped flush against it, which the schema rejects as overlap.
  const endEdge = Math.min(bounds.nextStartSec, startSec + length);
  // The guide only shows when clamping left the snapped edge on its target.
  const edgeSec = snappedEdge === "end" ? endEdge : startSec;
  const guideHeld = snappedEdge !== null && Math.abs(edgeSec - snapTarget) <= EPSILON;
  const isLast = blocks[blocks.length - 1]?.id === id;
  return {
    startSec,
    endSec: isLast && endEdge >= clipDurationSec - EPSILON ? null : endEdge,
    guideSec: guideHeld ? snapTarget : null,
  };
}

// ── Trim ────────────────────────────────────────────────────────────────────

export interface MusicTrimStartResult {
  startSec: number;
  sourceStartSec: number;
  guideSec: number | null;
}

/**
 * Left trim: the in-point moves with the edge, so the audio under the
 * remaining block does not shift. It cannot extend back past the track's
 * start (in-point 0) or into the previous block, and leaves the minimum
 * length.
 */
export function trimBlockStart(
  blocks: readonly StudioMusicBlock[],
  id: string,
  desiredStartSec: number,
  clipDurationSec: number,
  snap?: SnapConfig | null,
): MusicTrimStartResult | null {
  const block = blocks.find((candidate) => candidate.id === id);
  const bounds = blockBounds(blocks, id, clipDurationSec);
  if (!block || !bounds) return null;

  const min = Math.max(bounds.prevEndSec, block.startSec - block.sourceStartSec);
  const max = blockEndSec(block, clipDurationSec) - MUSIC_MIN_SEC;
  if (max < min - EPSILON) {
    return { startSec: block.startSec, sourceStartSec: block.sourceStartSec, guideSec: null };
  }
  const snapped = nearestSnap(desiredStartSec, snap);
  const startSec = clamp(snapped ?? desiredStartSec, min, Math.max(min, max));
  return {
    startSec,
    sourceStartSec: Math.max(0, block.sourceStartSec + (startSec - block.startSec)),
    guideSec: snapped !== null && Math.abs(startSec - snapped) <= EPSILON ? snapped : null,
  };
}

export interface MusicTrimEndResult {
  endSec: number | null;
  guideSec: number | null;
}

/**
 * Right trim: clamped at the next block or the clip end and at the minimum
 * length. The last block dragged to the clip end stores `endSec: null`, so a
 * full-length bed keeps following the clip when it is trimmed later.
 */
export function trimBlockEnd(
  blocks: readonly StudioMusicBlock[],
  id: string,
  desiredEndSec: number,
  clipDurationSec: number,
  snap?: SnapConfig | null,
): MusicTrimEndResult | null {
  const block = blocks.find((candidate) => candidate.id === id);
  const bounds = blockBounds(blocks, id, clipDurationSec);
  if (!block || !bounds) return null;

  const min = block.startSec + MUSIC_MIN_SEC;
  const max = bounds.nextStartSec;
  if (max < min - EPSILON) return { endSec: block.endSec, guideSec: null };
  const snapped = nearestSnap(desiredEndSec, snap);
  const endSec = clamp(snapped ?? desiredEndSec, min, max);
  const isLast = blocks[blocks.length - 1]?.id === id;
  return {
    endSec: isLast && endSec >= clipDurationSec - EPSILON ? null : endSec,
    guideSec: snapped !== null && Math.abs(endSec - snapped) <= EPSILON ? snapped : null,
  };
}

// ── Split ───────────────────────────────────────────────────────────────────

export type MusicSplitResult =
  | { ok: true; blocks: StudioMusicBlock[]; rightBlockId: string }
  | { ok: false; reason: "outside" | "limit" };

/** Whether `atSec` is at least the minimum length inside both edges of the block. */
export function canSplitBlock(
  block: StudioMusicBlock,
  atSec: number,
  clipDurationSec: number,
): boolean {
  return (
    atSec >= block.startSec + MUSIC_MIN_SEC - EPSILON &&
    atSec <= blockEndSec(block, clipDurationSec) - MUSIC_MIN_SEC + EPSILON
  );
}

/**
 * Splits one block in two independent blocks. The right half starts its
 * track where the left half stopped, wrapped to `trackDurationSec` when the
 * track's length is known. The cut itself adds no fade: the left keeps its
 * fade-in, the right keeps its fade-out.
 */
export function splitBlock(
  blocks: readonly StudioMusicBlock[],
  id: string,
  atSec: number,
  clipDurationSec: number,
  newId: string,
  trackDurationSec?: number | null,
): MusicSplitResult {
  const index = blocks.findIndex((block) => block.id === id);
  const block = blocks[index];
  if (!block || !canSplitBlock(block, atSec, clipDurationSec)) {
    return { ok: false, reason: "outside" };
  }
  if (blocks.length >= STUDIO_EDIT_LIMITS.musicBlocks) return { ok: false, reason: "limit" };

  const rawSource = block.sourceStartSec + (atSec - block.startSec);
  const sourceStartSec =
    trackDurationSec && trackDurationSec > 0 ? rawSource % trackDurationSec : rawSource;
  const left: StudioMusicBlock = { ...block, endSec: atSec, fadeOutSec: 0 };
  const right: StudioMusicBlock = {
    ...block,
    id: newId,
    startSec: atSec,
    sourceStartSec,
    fadeInSec: 0,
  };
  const next = [...blocks];
  next.splice(index, 1, left, right);
  return { ok: true, blocks: next, rightBlockId: newId };
}

// ── Add a track ─────────────────────────────────────────────────────────────

export type AddMusicTrackResult =
  | { kind: "added"; blocks: StudioMusicBlock[]; blockId: string }
  | { kind: "replaced"; blocks: StudioMusicBlock[]; blockId: string }
  | { kind: "no-room" }
  | { kind: "limit" };

/**
 * What the library's "Use" does:
 *  - no blocks: a full-length bed from 0;
 *  - playhead inside a block: that block takes the new track and keeps its
 *    timing, volume and fades, restarting the track from 0;
 *  - otherwise: a block at the playhead running to the next block or the
 *    clip end, when at least the minimum length fits.
 */
export function addMusicTrack(
  blocks: readonly StudioMusicBlock[],
  track: MusicTrack,
  playheadSec: number,
  clipDurationSec: number,
  newId: string,
): AddMusicTrackResult {
  if (blocks.length === 0) {
    return {
      kind: "added",
      blockId: newId,
      blocks: [newBlock(newId, track, 0, null)],
    };
  }

  const playhead = clamp(playheadSec, 0, clipDurationSec);
  const inside = blockAtTime(blocks, playhead, clipDurationSec);
  if (inside) {
    return {
      kind: "replaced",
      blockId: inside.id,
      blocks: patchMusicBlock(blocks, inside.id, {
        assetId: track.assetId,
        url: track.url,
        title: track.title,
        sourceStartSec: 0,
      }),
    };
  }

  if (blocks.length >= STUDIO_EDIT_LIMITS.musicBlocks) return { kind: "limit" };
  const next = blocks.find((block) => block.startSec > playhead);
  const limitSec = next ? next.startSec : clipDurationSec;
  if (limitSec - playhead < MUSIC_MIN_SEC - EPSILON) return { kind: "no-room" };

  const created = newBlock(newId, track, playhead, next ? limitSec : null);
  const insertAt = next ? blocks.indexOf(next) : blocks.length;
  const result = [...blocks];
  result.splice(insertAt, 0, created);
  return { kind: "added", blockId: newId, blocks: result };
}

function newBlock(
  id: string,
  track: MusicTrack,
  startSec: number,
  endSec: number | null,
): StudioMusicBlock {
  return {
    id,
    assetId: track.assetId,
    url: track.url,
    title: track.title,
    startSec,
    endSec,
    sourceStartSec: 0,
    volume: MUSIC_DEFAULT_VOLUME,
    fadeInSec: 0,
    fadeOutSec: 0,
  };
}

// ── Presentation helpers ────────────────────────────────────────────────────

/** `00:12.52`, the readout used by the trim and move tooltips. */
export function formatMusicTime(timeSec: number): string {
  const safe = Math.max(0, timeSec);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const hundredths = Math.floor((safe % 1) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

/** Times (relative to the block start) where the looped track restarts. */
export function loopPointsSec(
  sourceStartSec: number,
  blockDurSec: number,
  trackDurationSec: number | null,
): number[] {
  if (!trackDurationSec || trackDurationSec <= 0 || blockDurSec <= 0) return [];
  const points: number[] = [];
  let next = trackDurationSec - (sourceStartSec % trackDurationSec);
  while (next < blockDurSec - EPSILON && points.length < 64) {
    if (next > EPSILON) points.push(next);
    next += trackDurationSec;
  }
  return points;
}

/**
 * Waveform amplitudes (0..1) for `columns` equal slices of one block: each
 * column reads the track at its in-point plus its offset into the block,
 * wrapped to the track length so a looping block repeats its waveform.
 */
export function blockWaveformColumns(
  peaks: ArrayLike<number>,
  trackDurationSec: number,
  sourceStartSec: number,
  blockDurSec: number,
  columns: number,
): number[] {
  if (peaks.length === 0 || trackDurationSec <= 0 || blockDurSec <= 0 || columns <= 0) return [];
  const out: number[] = new Array(columns);
  for (let column = 0; column < columns; column++) {
    const trackTime = (sourceStartSec + ((column + 0.5) / columns) * blockDurSec) % trackDurationSec;
    const index = Math.min(peaks.length - 1, Math.floor((trackTime / trackDurationSec) * peaks.length));
    out[column] = peaks[index] ?? 0;
  }
  return out;
}

/** Evenly strided peak extraction: cheap enough for a long track on the main thread. */
export function computePeaks(
  channels: readonly Float32Array[],
  bucketCount: number,
  samplesPerBucket = 192,
): Float32Array {
  const peaks = new Float32Array(bucketCount);
  const length = channels[0]?.length ?? 0;
  if (length === 0 || bucketCount <= 0) return peaks;
  const bucketSize = length / bucketCount;
  const stride = Math.max(1, Math.floor(bucketSize / samplesPerBucket));
  let max = 0;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const from = Math.floor(bucket * bucketSize);
    const to = Math.min(length, Math.floor((bucket + 1) * bucketSize));
    let peak = 0;
    for (const channel of channels) {
      for (let i = from; i < to; i += stride) {
        const value = Math.abs(channel[i] ?? 0);
        if (value > peak) peak = value;
      }
    }
    peaks[bucket] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) for (let bucket = 0; bucket < bucketCount; bucket++) peaks[bucket] = (peaks[bucket] ?? 0) / max;
  return peaks;
}
