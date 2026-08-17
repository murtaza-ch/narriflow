const UUID_SUFFIX =
  /-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i;

export function clipRenderAttemptStorageKey(
  projectId: string,
  clipId: string,
  aspectRatioSlug: string,
  attemptId: string,
): string {
  return `projects/${projectId}/renders/${clipId}/${aspectRatioSlug}-${attemptId}.mp4`;
}

export function clipExportAttemptStorageKey(input: {
  projectId: string;
  exportId: string;
  variantId: string;
  aspectRatioSlug: string;
  attemptId: string;
}): string {
  return `projects/${input.projectId}/exports/${input.exportId}/${input.variantId}-${input.aspectRatioSlug}-${input.attemptId}.mp4`;
}

export function isAttemptUniqueProjectRenderObjectKey(
  key: string,
  projectId: string,
): boolean {
  const parts = key.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== "projects" ||
    parts[1]?.toLowerCase() !== projectId.toLowerCase() ||
    (parts[2] !== "renders" && parts[2] !== "exports") ||
    !parts[3] ||
    !parts[4]
  ) {
    return false;
  }
  return UUID_SUFFIX.test(parts[4]);
}
