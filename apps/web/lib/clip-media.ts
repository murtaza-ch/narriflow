export interface ClipMediaResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ClipMediaFetcher = (input: string) => Promise<ClipMediaResponse>;

export interface ClipMediaHttpResult {
  ok: boolean;
  status: number;
  payload: unknown;
}

export interface ClipMediaDescriptor {
  downloadUrl: string;
  fileName: string;
  expiresInSeconds: number;
  isPreviewProxy: boolean;
  previewStartSec: number;
}

interface PreviewCacheEntry {
  requestedAt: number;
  promise: Promise<ClipMediaHttpResult>;
}

const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const previewCache = new Map<string, PreviewCacheEntry>();

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function clipMediaPayloadForClip(
  payload: unknown,
  clipId: string,
): unknown | null {
  if (!payload || typeof payload !== "object") return null;
  const previews = (payload as Record<string, unknown>).previews;
  if (!previews || typeof previews !== "object") return null;
  return (previews as Record<string, unknown>)[clipId] ?? null;
}

export function clipMediaDescriptorFromPayload(
  payload: unknown,
): ClipMediaDescriptor | null {
  const downloadUrl = readString(payload, "downloadUrl");
  const fileName = readString(payload, "fileName");
  if (!downloadUrl || !fileName) return null;

  try {
    const url = new URL(downloadUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const rawExpiry = value.expiresInSeconds;
  const rawOffset = value.previewStartSec;
  return {
    downloadUrl,
    fileName,
    expiresInSeconds:
      typeof rawExpiry === "number" && Number.isFinite(rawExpiry)
        ? rawExpiry
        : 0,
    isPreviewProxy: value.isPreviewProxy === true,
    previewStartSec:
      typeof rawOffset === "number" && Number.isFinite(rawOffset)
        ? rawOffset
        : 0,
  };
}

/** Shares signed-preview discovery across React remounts and sibling callers. */
export function loadClipPreview(
  requestUrl: string,
  fetcher: ClipMediaFetcher = fetch,
): Promise<ClipMediaHttpResult> {
  const now = Date.now();
  const cached = previewCache.get(requestUrl);
  if (cached && now - cached.requestedAt < PREVIEW_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = fetcher(requestUrl)
    .then(async (response) => ({
      ok: response.ok,
      status: response.status,
      payload: await response.json().catch(() => null),
    }))
    .then((result) => {
      if (!result.ok) previewCache.delete(requestUrl);
      return result;
    })
    .catch((error: unknown) => {
      previewCache.delete(requestUrl);
      throw error;
    });

  previewCache.set(requestUrl, { requestedAt: now, promise });
  return promise;
}

export function clipFileDownloadPath(
  projectId: string,
  clipId: string,
  aspectRatio: string,
): string {
  return (
    `/api/projects/${encodeURIComponent(projectId)}` +
    `/clips/${encodeURIComponent(clipId)}/file` +
    `?aspectRatio=${encodeURIComponent(aspectRatio)}`
  );
}
