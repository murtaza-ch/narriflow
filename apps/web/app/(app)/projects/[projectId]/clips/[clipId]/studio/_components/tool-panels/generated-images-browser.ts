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
