import { isApiError, ApiError, type ApiTransport, type WorkspaceScope } from "../core";
import { createIngestClient } from "./client";

/** Pending work belongs to the captured identity/Workspace. Scoped transport
 * aborts it on a scope change; no response can update another Workspace. */
export async function waitForRssProbe(transport: ApiTransport, scope: WorkspaceScope, jobId: string, signal?: AbortSignal) {
  const client = createIngestClient(transport.scoped(scope));
  for (let attempt = 0; attempt < 60; attempt++) {
    signal?.throwIfAborted();
    const job = await (await client.ingest.rss.probes[":id"].$get({ param: { id: jobId } }, { init: { signal } })).json();
    if (job.status === "ready" && job.result) return job.result;
    if (job.status === "failed") throw new ApiError({ status: 422, code: job.errorCode ?? "remote_download_failed", message: "The RSS feed could not be loaded." });
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 1000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  throw new ApiError({ status: 409, code: "rss_probe_pending", message: "The feed is still being checked. Try again shortly.", details: { jobId } });
}


export async function afterRssProbe<T>(transport: ApiTransport, scope: WorkspaceScope, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (!isApiError(error) || error.code !== "rss_probe_pending" || typeof error.details?.jobId !== "string") throw error;
    await waitForRssProbe(transport, scope, error.details.jobId, signal);
    return operation();
  }
}
