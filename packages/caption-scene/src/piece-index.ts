import type { Piece } from "./scene";

/**
 * A time index over a scene's pieces. A 3-minute clip has thousands of pieces (Wordform: 5300) and
 * a renderer asks "which pieces are live now?" on every tick, so the question is answered from
 * one-second buckets instead of by walking every piece: each piece is listed in the buckets its
 * window `[fromMs, toMs)` touches, and a query checks only the pieces of one bucket against the
 * exact window. A piece that outlives `MAX_BUCKETS_PER_PIECE` buckets (a persistent dial) is kept
 * in a short list that every query checks.
 */
const BUCKET_MS = 1000;
const MAX_BUCKETS_PER_PIECE = 64;

export interface PieceIndex {
  readonly base: number;
  readonly buckets: readonly (readonly number[])[];
  /** Pieces whose window is too long to list in every bucket it touches. */
  readonly long: readonly number[];
}

export function indexPieces(pieces: readonly Piece[]): PieceIndex {
  let base = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const piece of pieces) {
    base = Math.min(base, piece.fromMs);
    end = Math.max(end, piece.toMs);
  }
  if (!Number.isFinite(base)) return { base: 0, buckets: [], long: [] };
  base = Math.floor(base / BUCKET_MS) * BUCKET_MS;
  const buckets: number[][] = Array.from({ length: Math.floor((end - base) / BUCKET_MS) + 1 }, () => []);
  const long: number[] = [];
  pieces.forEach((piece, at) => {
    const first = Math.floor((piece.fromMs - base) / BUCKET_MS);
    const last = Math.floor((piece.toMs - base) / BUCKET_MS);
    if (last - first >= MAX_BUCKETS_PER_PIECE) {
      long.push(at);
      return;
    }
    for (let bucket = first; bucket <= last; bucket++) buckets[bucket]!.push(at);
  });
  return { base, buckets, long };
}

const indexes = new WeakMap<readonly Piece[], { readonly size: number; readonly index: PieceIndex }>();

/**
 * The index of `pieces`, built once per array. A scene's `pieces` never change; a program that grows
 * an array between queries gets a fresh index because the cached one remembers the length it indexed.
 */
export function pieceIndexOf(pieces: readonly Piece[]): PieceIndex {
  const cached = indexes.get(pieces);
  if (cached && cached.size === pieces.length) return cached.index;
  const index = indexPieces(pieces);
  indexes.set(pieces, { size: pieces.length, index });
  return index;
}

/** Positions in `pieces` of the pieces visible at `ms` (`fromMs <= ms < toMs`), in no particular order. */
export function livePieceIndexes(pieces: readonly Piece[], ms: number): number[] {
  const index = pieceIndexOf(pieces);
  const live: number[] = [];
  const bucket = index.buckets[Math.floor((ms - index.base) / BUCKET_MS)];
  if (bucket) {
    for (const at of bucket) {
      const piece = pieces[at]!;
      if (ms >= piece.fromMs && ms < piece.toMs) live.push(at);
    }
  }
  for (const at of index.long) {
    const piece = pieces[at]!;
    if (ms >= piece.fromMs && ms < piece.toMs) live.push(at);
  }
  return live;
}

/** Positions of the pieces whose window touches `[fromMs, toMs)`, in array order: what a renderer keeps mounted around the playhead. */
export function pieceIndexesBetween(pieces: readonly Piece[], fromMs: number, toMs: number): number[] {
  const index = pieceIndexOf(pieces);
  const seen = new Set<number>(index.long);
  const first = Math.max(0, Math.floor((fromMs - index.base) / BUCKET_MS));
  const last = Math.min(index.buckets.length - 1, Math.floor((toMs - index.base) / BUCKET_MS));
  for (let bucket = first; bucket <= last; bucket++) for (const at of index.buckets[bucket]!) seen.add(at);
  return [...seen].filter((at) => pieces[at]!.fromMs < toMs && pieces[at]!.toMs > fromMs).sort((a, b) => a - b);
}
