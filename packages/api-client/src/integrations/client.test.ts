import { describe, expect, test } from "bun:test";
import { buildGenerationContentPack } from "@narriflow/validators";
import { createMcpUploadControls } from "./upload";
import { ApiError, createApiRuntime } from "../core";
import { mcpContinuationDigest, mcpPreparationQueryOptions, mcpUploadHandoffQueryOptions, mcpStatusQueryOptions } from "./queries";
import { mcpConfirmationMutationOptions } from "./mutations";

function harness(status = 200) {
  const requests: { url: string; init: RequestInit }[] = [];
  const runtime = createApiRuntime({ baseUrl: "https://api.test", getToken: async () => "session-token", fetch: async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json(status === 200 ? { destination: "/integrations/mcp" } : { error: "mcp_continuation_revoked", message: "Revoked", requestId: "request-test" }, { status });
  } });
  runtime.setIdentity("user");
  runtime.selectWorkspace("unrelated-workspace");
  return { runtime, requests, scope: { userId: "user" } };
}

describe("MCP browser client", () => {
  test("signed continuation reads use identity Bearer, AbortSignal and digest-only keys", async () => {
    const h = harness();
    const token = "private-signed-continuation";
    const digest = await mcpContinuationDigest(token);
    for (const query of [mcpPreparationQueryOptions({ transport: h.runtime.transport, scope: h.scope, token, digest }), mcpUploadHandoffQueryOptions({ transport: h.runtime.transport, scope: h.scope, intent: token, digest })]) {
      expect(JSON.stringify(query.queryKey)).not.toContain(token);
      expect(JSON.stringify(query.queryKey)).toContain(digest);
      await h.runtime.queryClient.fetchQuery(query);
    }
    for (const { init } of h.requests) {
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer session-token");
      expect(headers.get("X-Workspace-Id")).toBeNull();
      expect(init.credentials).toBe("omit");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    h.runtime.queryClient.clear();
  });
  test("status uses the scoped API URL and selection header", async () => {
    const h = harness();
    await h.runtime.queryClient.fetchQuery(mcpStatusQueryOptions({ transport: h.runtime.transport, scope: { ...h.scope, workspaceId: "unrelated-workspace" } }));
    expect(h.requests[0]?.url).toBe("https://api.test/api/integrations/mcp/status");
    expect(new Headers(h.requests[0]?.init.headers).get("X-Workspace-Id")).toBe("unrelated-workspace");
    h.runtime.queryClient.clear();
  });
  test("confirmation is typed and keeps its native signed intent on retry", async () => {
    const h = harness();
    const mutation = mcpConfirmationMutationOptions({ transport: h.runtime.transport, scope: h.scope });
    const result = await mutation.mutationFn!({ token: "signed-intent", decision: "confirm" }, {} as never);
    expect(result.destination).toBe("/integrations/mcp");
    expect(h.requests[0]?.url).toBe("https://api.test/api/mcp/confirmations");
    expect(JSON.parse(String(h.requests[0]?.init.body))).toEqual({ token: "signed-intent", decision: "confirm" });
    expect(new Headers(h.requests[0]?.init.headers).get("X-Workspace-Id")).toBeNull();
  });
  test("semantic failure is a typed ApiError", async () => {
    const h = harness(403);
    const mutation = mcpConfirmationMutationOptions({ transport: h.runtime.transport, scope: h.scope });
    try {
      await mutation.mutationFn!({ token: "signed", decision: "confirm" }, {} as never);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: "mcp_continuation_revoked", status: 403, requestId: "request-test" });
    }
  });
});


test("expired upload controls resume through API identity transport with the signed intent", async () => {
  const h = harness();
  const controls = createMcpUploadControls({ transport: h.runtime.transport, scope: h.scope, workspaceId: "signed-workspace", token: "private-handoff", resumeOnly: true });
  await controls.open({
    clientIdempotencyKey: "00000000-0000-4000-8000-000000000001", title: "talk.mp4", source: { fileName: "talk.mp4", sizeBytes: 100, contentType: "video/mp4", browserFingerprint: "fingerprint" }, generationContext: { contentPack: buildGenerationContentPack(), languageCode: null },
  });
  const control = h.requests[0]!;
  expect(control.url).toBe("https://api.test/mcp/integrations/signed-workspace/upload-sessions/status");
  expect(JSON.parse(String(control.init.body))).toEqual({ clientIdempotencyKey: "00000000-0000-4000-8000-000000000001", sessionId: null, browserFingerprint: "fingerprint" });
  expect(new Headers(control.init.headers).get("X-Narriflow-Upload-Intent")).toBe("private-handoff");
  expect(new Headers(control.init.headers).get("Authorization")).toBe("Bearer session-token");
  expect(new Headers(control.init.headers).get("X-Workspace-Id")).toBeNull();
  expect(control.init.credentials).toBe("omit");
});
