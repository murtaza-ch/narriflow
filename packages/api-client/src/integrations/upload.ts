import { discardUploadSessionSchema, finalizeUploadSessionSchema, grantUploadPartsSchema, openUploadSessionSchema, readUploadSessionSchema } from "@narriflow/validators";
import type { ApiTransport, IdentityScope } from "../core";

export interface McpUploadControls {
  open(input: unknown, signal?: AbortSignal): Promise<unknown>;
  status(input: unknown, signal?: AbortSignal): Promise<unknown>;
  grants(input: unknown, signal?: AbortSignal): Promise<unknown>;
  finalize(input: unknown, signal?: AbortSignal): Promise<unknown>;
  discard(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** Only Upload Session controls go through this session Bearer + signed intent
 * transport. The browser adapter keeps presigned storage PUTs separate. */
export function createMcpUploadControls(input: {
  transport: ApiTransport;
  scope: IdentityScope;
  workspaceId: string;
  token: string;
  resumeOnly: boolean;
}): McpUploadControls {
  const control = input.transport.identity(input.scope);
  const request = (action: string, json: unknown, signal?: AbortSignal) =>
    control.json(`/mcp/integrations/${encodeURIComponent(input.workspaceId)}/upload-sessions/${action}`, {
      method: "POST", json, signal, headers: { "X-Narriflow-Upload-Intent": input.token },
    });
  return {
    open(value, signal) {
      const opening = openUploadSessionSchema.parse(value);
      if (input.resumeOnly) {
        return request("status", { clientIdempotencyKey: opening.clientIdempotencyKey, sessionId: null, browserFingerprint: opening.source.browserFingerprint }, signal);
      }
      return request("open", opening, signal);
    },
    status: (value, signal) => request("status", readUploadSessionSchema.parse(value), signal),
    grants: (value, signal) => request("grants", grantUploadPartsSchema.parse(value), signal),
    finalize: (value, signal) => request("finalize", finalizeUploadSessionSchema.parse(value), signal),
    discard: (value, signal) => request("discard", discardUploadSessionSchema.parse(value), signal),
  };
}
