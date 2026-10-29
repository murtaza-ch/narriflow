import { ApiError, type Intent } from "@narriflow/api-client/core";
import { type BrandApi, brandClientFor } from "@narriflow/api-client/brand";
import { apiFailureBody } from "../studio-api";
import type { BrowserRequestFailure } from "@/lib/authenticated-request-browser";

/**
 * Generated-image calls over the typed Brand client. Each resolves with the
 * HTTP response whatever its status, so the panel reads one status/body shape
 * for success and refusal (typed `ApiError`s become their envelope response);
 * it rejects only when no response arrived.
 */
export interface GeneratedImagesBrowserApi {
  list(clipId: string): Promise<Response>;
  /** The key is the intent's: the same body keeps it through retries and lost responses, until accepted. */
  create(body: Record<string, unknown>): Promise<Response>;
  cancel(jobId: string): Promise<Response>;
  deleteResult(jobId: string): Promise<Response>;
  saveToBrandProfile(profileId: string, body: unknown): Promise<Response>;
}

async function settled(request: () => Promise<Response>): Promise<Response> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiError && error.status > 0) {
      const { ok: _ok, ...envelope } = apiFailureBody(error);
      return Response.json(envelope, { status: error.status });
    }
    throw error;
  }
}

export type GeneratedImageIntent = Intent<Record<string, unknown>>;

export function createGeneratedImagesBrowserApi(
  projectId: string,
  api: BrandApi,
  intent: GeneratedImageIntent,
): GeneratedImagesBrowserApi {
  const jobs = () => brandClientFor(api).projects[":projectId"]["generated-media"].jobs;
  return {
    list: (clipId) => settled(() => jobs().$get({ param: { projectId }, query: { clipId } })),
    create: async (body) => {
      const json = { ...body, idempotencyKey: intent.keyFor(body) };
      const response = await settled(() =>
        jobs().$post({ param: { projectId }, json: json as Parameters<ReturnType<typeof jobs>["$post"]>[0]["json"] }),
      );
      if (response.ok) intent.complete();
      return response;
    },
    cancel: (jobId) => settled(() => jobs()[":id"].cancel.$post({ param: { projectId, id: jobId } })),
    deleteResult: (jobId) => settled(() => jobs()[":id"].result.$delete({ param: { projectId, id: jobId } })),
    saveToBrandProfile: (profileId, body) =>
      settled(() =>
        brandClientFor(api)["brand-profiles"][":id"].membership.$put({
          param: { id: profileId },
          json: body as never,
        }),
      ),
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
