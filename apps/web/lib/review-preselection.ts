import { decodeReviewSelection } from "@narriflow/validators/review-selection";

type Candidate = { id: string; editorRevision: number; exports: Array<{ id: string; editorRevision: number; variants: Array<{ id: string }> }> };
export type ReviewPreselection = { selections: Record<string, { exportId: string; variantIds: string[]; required: boolean }>; dropped: number };

/** Rechecks an assistant's review handoff against the composer's current
 * candidates: each export must still be ready, current for its clip, and
 * offer the selected completed formats. The URL carries no authority. */
export function resolveReviewPreselection(candidates: Candidate[], encoded: string | undefined): ReviewPreselection | null {
  const requested = decodeReviewSelection(encoded);
  if (requested.length === 0) return null;
  const selections: ReviewPreselection["selections"] = {};
  for (const item of requested) {
    const candidate = candidates.find((entry) => entry.exports.some((exported) => exported.id === item.exportId));
    const exported = candidate?.exports.find((entry) => entry.id === item.exportId);
    const formats = new Set(exported?.variants.map((variant) => variant.id) ?? []);
    if (!candidate || !exported || exported.editorRevision !== candidate.editorRevision || selections[candidate.id] || item.variantIds.some((id) => !formats.has(id))) continue;
    selections[candidate.id] = { exportId: exported.id, variantIds: item.variantIds, required: true };
  }
  return { selections, dropped: requested.length - Object.keys(selections).length };
}
