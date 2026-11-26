import type { Piece, SceneWindow } from "./scene";

/**
 * The scene's pieces with no window inside an inserted scene. A piece whose window crosses one stops at its start and,
 * when it runs on past its end, starts again there. Tracks are keyframes in absolute clip time, so a cut piece is where
 * and how it was at every instant it still paints. The part after a cut keeps the piece's id with `#n` appended (its
 * cue segment, the second, is unchanged) and its place in the array, so paint order holds. A piece no window touches is
 * the same object, and with no windows the array is returned as it is.
 */
export function cutAtInsertedScenes(pieces: readonly Piece[], windows: readonly SceneWindow[]): readonly Piece[] {
  if (windows.length === 0) return pieces;
  const cut: Piece[] = [];
  for (const piece of pieces) {
    let fromMs = piece.fromMs;
    let part = 0;
    const keep = (toMs: number) => {
      if (toMs <= fromMs) return;
      cut.push(fromMs === piece.fromMs && toMs === piece.toMs ? piece : { ...piece, id: part === 0 ? piece.id : `${piece.id}#${part}`, fromMs, toMs });
      part++;
    };
    for (const window of windows) {
      if (window.toMs <= fromMs || window.fromMs >= piece.toMs) continue;
      keep(window.fromMs);
      fromMs = Math.max(fromMs, window.toMs);
      if (fromMs >= piece.toMs) break;
    }
    keep(piece.toMs);
  }
  return cut;
}
