/** The copy shown beside every credit, here so the panel and the export menu say it once. */
export const AUDIO_CREDIT_HINT = "Paste this into your video description.";

interface CreditEdits {
  music: { blocks: readonly { assetId: string | null }[] };
  sfx: readonly { assetId: string | null }[];
}

/** Every distinct asset a clip uses, music blocks first: the ids whose credits must be known. */
export function audioCreditAssetIds(edits: CreditEdits): string[] {
  const ids = new Set<string>();
  for (const { assetId } of [...edits.music.blocks, ...edits.sfx]) if (assetId) ids.add(assetId);
  return [...ids];
}

/**
 * The credit lines a clip owes: one per distinct attribution, in the order the
 * tracks appear (music blocks first, then sound effects). An asset whose
 * attribution is not known, or is null, owes nothing.
 */
export function audioCreditLines(
  edits: CreditEdits,
  attributions: ReadonlyMap<string, string | null>,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const ids = [
    ...edits.music.blocks.map((block) => block.assetId),
    ...edits.sfx.map((placement) => placement.assetId),
  ];
  for (const id of ids) {
    const line = id ? attributions.get(id)?.trim() : null;
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** Credits as one paste: a blank line between tracks. */
export function joinAudioCredits(lines: readonly string[]): string {
  return lines.join("\n\n");
}
