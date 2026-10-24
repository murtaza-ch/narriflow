import { describe, expect, spyOn, test } from "bun:test";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import { assertInlineFinishing, integrationKeyUuid, integrationUploadSessionKey, integrationUploadSessions, requireQueueDeliveryScope, submitVideo } from "./integration-commands";
import { projectService } from "./project.service";
import { workspaceService } from "./workspace.service";
import type { UploadSessionService } from "./upload-session.service";

const USER = "00000000-0000-4000-8000-000000000001";

describe("integration key derivation", () => {
  test("matches a reference RFC 9562 UUIDv5 implementation", () => {
    // Python: uuid.uuid5(NAMESPACE, json.dumps([USER, "open_upload", "key-1"], separators=(",", ":")))
    expect(integrationUploadSessionKey(USER, "key-1")).toBe("790b6618-ff64-5dc6-85d6-ca43e6873cc0");
  });

  test("separates users, commands, and caller keys", () => {
    const base = integrationKeyUuid(USER, "generate_clips", "key-1");
    expect(integrationKeyUuid(USER, "generate_clips", "key-1")).toBe(base);
    expect(integrationKeyUuid("00000000-0000-4000-8000-000000000002", "generate_clips", "key-1")).not.toBe(base);
    expect(integrationKeyUuid(USER, "open_upload", "key-1")).not.toBe(base);
    expect(integrationKeyUuid(USER, "generate_clips", "key-2")).not.toBe(base);
    // Tuple serialization is unambiguous across component boundaries.
    expect(integrationKeyUuid(USER, "generate_clips", "a\",\"b")).not.toBe(integrationKeyUuid(USER, "generate_clips", "a"));
  });
});

describe("integration Upload Sessions", () => {
  const actor = { actorUserId: USER, workspaceId: "00000000-0000-4000-8000-000000000009" };
  const paused = () => { throw new ExpectedDomainFailureError({ code: "mutations_unavailable", kind: "unavailable", message: "Paused" }); };
  const opening = (fingerprint: string) => ({ clientIdempotencyKey: "caller-key", title: "Talk", source: { fileName: "talk.mp4", sizeBytes: 10, contentType: "video/mp4" as const, browserFingerprint: fingerprint },
    generationContext: { contentPack: {} as never, languageCode: null } });

  test("MCP and REST opening the same file under one key send identical session input", async () => {
    const seen: unknown[] = [];
    const sessions = integrationUploadSessions({ open: async (_actor: unknown, input: unknown) => { seen.push(input); return {} as never; } } as unknown as UploadSessionService);
    await sessions.open(actor, opening("sha256-from-the-cli"));
    await sessions.open(actor, opening("rest"));
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toMatchObject({ clientIdempotencyKey: integrationUploadSessionKey(USER, "caller-key") });
  });

  test("finalize pauses during a limiter outage unless its finalization was already accepted", async () => {
    let state = "uploading";
    let finalized = 0;
    const sessions = integrationUploadSessions({
      statusById: async () => ({ outcome: state }) as never,
      finalize: async () => { finalized++; return {} as never; },
    } as unknown as UploadSessionService);
    await expect(sessions.finalize(actor, { sessionId: "s", parts: [] }, {}, paused)).rejects.toMatchObject({ code: "mutations_unavailable" });
    expect(finalized).toBe(0);
    state = "reconciling";
    await sessions.finalize(actor, { sessionId: "s", parts: [] }, {}, paused);
    expect(finalized).toBe(1);
  });
});

describe("finishing that sends a review round", () => {
  const actor = { actorUserId: USER, workspaceId: "00000000-0000-4000-8000-000000000009" };

  test("belongs to an Autopilot rule, so an inline request is refused before anything else", async () => {
    await expect(assertInlineFinishing(actor, { delivery: "send_review_round" })).rejects.toMatchObject({ code: "finishing_review_delivery_rule_only", kind: "invalid" });
    // Stopping at review names no accounts, so there is nothing more to check.
    await assertInlineFinishing(actor, { delivery: "ready_to_review" });
    await assertInlineFinishing(actor, undefined);
  });
});

describe("finishing that proposes to the queue", () => {
  const queueing = { topClips: 2, delivery: "propose_to_queue" as const, queueAccountIds: ["00000000-0000-4000-8000-000000000008"] };

  test("needs the publishing write scope on top of the command's own", () => {
    expect(() => requireQueueDeliveryScope({ scopes: ["processing:write"] }, queueing)).toThrow(expect.objectContaining({ code: "scope_required", details: { scope: "publishing:write" } }));
    requireQueueDeliveryScope({ scopes: ["processing:write", "publishing:write"] }, queueing);
    // Stopping at review touches no publishing state.
    requireQueueDeliveryScope({ scopes: ["processing:write"] }, { delivery: "ready_to_review" });
    requireQueueDeliveryScope({ scopes: [] }, undefined);
  });

  test("needs the acting person to manage publishing, checked before any work is accepted", async () => {
    const requireActor = spyOn(workspaceService, "requireActor").mockRejectedValue(new ExpectedDomainFailureError({ code: "workspace_access_denied", kind: "forbidden", message: "No publishing access" }));
    const intake = spyOn(projectService, "queueLinkIngest").mockRejectedValue(new Error("must not run"));
    try {
      await expect(submitVideo({ actorUserId: USER, workspaceId: "00000000-0000-4000-8000-000000000009" }, { url: "https://youtu.be/x", generation: {} as never, finishing: queueing }, { clientIdempotencyKey: "k" }))
        .rejects.toMatchObject({ code: "workspace_access_denied" });
      expect(requireActor).toHaveBeenCalledWith(USER, "00000000-0000-4000-8000-000000000009", "publishing.manage");
      expect(intake).not.toHaveBeenCalled();
    } finally { requireActor.mockRestore(); intake.mockRestore(); }
  });
});
