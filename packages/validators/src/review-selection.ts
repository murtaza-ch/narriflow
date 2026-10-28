/**
 * Composer preselection travels in the URL as `exportId:variantId,variantId;...`.
 * It carries no authority; the composer rechecks every item. Pure and
 * client-safe so the browser decodes it without the services bundle.
 */
export interface ReviewSelectionItem {
  exportId: string;
  variantIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeReviewSelection(items: ReviewSelectionItem[]): string {
  return items
    .map((item) => `${item.exportId}:${item.variantIds.join(",")}`)
    .join(";");
}

export function decodeReviewSelection(
  value: string | undefined | null,
): ReviewSelectionItem[] {
  if (!value || value.length > 4_000) return [];
  return value
    .split(";")
    .slice(0, 20)
    .flatMap((entry) => {
      const [exportId, variants = ""] = entry.split(":");
      const variantIds = variants
        .split(",")
        .filter((id) => UUID.test(id))
        .slice(0, 4);
      return exportId && UUID.test(exportId) && variantIds.length
        ? [{ exportId, variantIds }]
        : [];
    });
}
