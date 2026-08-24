import type { ClipExportStatus } from "@narriflow/validators";

export type ClipExportVariantStatus =
  | "pending"
  | "rendering"
  | "completed"
  | "failed";

export function deriveClipExportAggregate(
  statuses: ClipExportVariantStatus[],
): { status: ClipExportStatus; progress: number; terminal: boolean } {
  if (statuses.length === 0) {
    return { status: "failed", progress: 100, terminal: true };
  }
  const completed = statuses.filter((status) => status === "completed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const rendering = statuses.filter((status) => status === "rendering").length;
  const settled = completed + failed;

  if (completed === statuses.length) {
    return { status: "ready", progress: 100, terminal: true };
  }
  if (settled === statuses.length) {
    return completed > 0
      ? { status: "partial_ready", progress: 100, terminal: true }
      : { status: "failed", progress: 100, terminal: true };
  }
  return {
    status: rendering > 0 || settled > 0 ? "rendering" : "queued",
    progress: Math.min(
      95,
      Math.round((settled / statuses.length) * 90) + (rendering > 0 ? 5 : 0),
    ),
    terminal: false,
  };
}
