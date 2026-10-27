import type { BrowserRequestFailure } from "@/lib/authenticated-request-browser";

export interface GeneratedImagesBrowserApi {
  list(clipId: string): Promise<Response>;
  create(body: unknown): Promise<Response>;
  cancel(jobId: string): Promise<Response>;
  deleteResult(jobId: string): Promise<Response>;
}

export function createGeneratedImagesBrowserApi(
  projectId: string,
  request: typeof fetch = fetch,
): GeneratedImagesBrowserApi {
  const base = `/api/projects/${encodeURIComponent(projectId)}/generated-media/jobs`;
  return {
    list(clipId) {
      return request(`${base}?clipId=${encodeURIComponent(clipId)}`, { cache: "no-store" });
    },
    create(body) {
      return request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    cancel(jobId) {
      return request(`${base}/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    },
    deleteResult(jobId) {
      return request(`${base}/${encodeURIComponent(jobId)}/result`, { method: "DELETE" });
    },
  };
}

/** Where a frame that cannot be deleted is still used, so the person knows what to remove first. */
export function assetInUseCopy(payload: BrowserRequestFailure): string | null {
  if (payload.error !== "visual_asset_in_use") return null;
  const usedIn = payload.details?.usedIn;
  return typeof usedIn === "string" && usedIn
    ? `Used in: ${usedIn}. Remove it there first.`
    : "This frame is still in use. Remove it there first.";
}
