import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { getOutboundProbeService } from "./outbound-probe-runtime";
import type { RssFeedSnapshot } from "@narriflow/validators/outbound-probe";
export * from "./rss-parser";

export type FetchRssFeedOptions = { scope: ActorScope; etag?: string | null; lastModified?: string | null; requestKey?: string };
export class RssProbePending extends ExpectedDomainFailureError {
  constructor(jobId: string) { super({ code: "rss_probe_pending", kind: "conflict", message: "The RSS feed is being checked. Retry when the probe is ready.", details: { jobId } }); }
}
/** API/Workflow callers read a native executor's sealed snapshot. They never
 * resolve or connect to a caller-supplied host in the Worker. */
export async function fetchRssFeed(url: string, options: FetchRssFeedOptions): Promise<RssFeedSnapshot> {
  const service = getOutboundProbeService();
  const admitted = await service.admit(options.scope, { kind: "rss_feed", url, etag: options.etag ?? null, lastModified: options.lastModified ?? null }, options.requestKey);
  const job = await service.get(options.scope, admitted.jobId);
  if (job.status === "pending") throw new RssProbePending(job.jobId);
  if (!job.result) throw new ExpectedDomainFailureError({ code: job.errorCode ?? "remote_download_failed", kind: "unprocessable", message: "The RSS feed could not be fetched" });
  return job.result;
}
export async function fetchRssEpisodes(url: string, options: FetchRssFeedOptions) { return (await fetchRssFeed(url, options)).episodes; }
