import { describe, expect, mock, test } from "bun:test";
import { ClerkEmailConflictError, ClerkIdentityDeletedError, isWorkspaceId, type AppUser, type VerifiedClerkIdentity, type WorkspaceActorContext } from "@narriflow/auth";
import { createRequestPolicyRuntime, type RequestPolicyRuntimeOptions } from "./request-policy-runtime";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const identity = { clerkUserId: "clerk-1", sessionId: "s" } as VerifiedClerkIdentity;
const user = { id: "user-1", clerkId: "clerk-1" } as AppUser;
const context: WorkspaceActorContext = {
  userId: "user-1",
  workspaceId: WORKSPACE_ID,
  workspaceName: "W",
  workspaceOwnerUserId: "user-1",
  role: "editor",
  status: "active",
  pricingTier: "pro",
  isPersonal: false,
  workspaceSelectionChanged: false,
};

function runtime(overrides: Partial<RequestPolicyRuntimeOptions> = {}) {
  const loadAppUser = mock(async () => user);
  const resolveScopedWorkspace = mock(async () => context);
  const built = createRequestPolicyRuntime({
    authenticate: async () => ({ status: "authenticated", identity }),
    loadAppUser,
    resolveScopedWorkspace,
    staffAllowlist: new Set(),
    policy: { resolveProject: async () => ({ kind: "missing" }), rateLimit: async () => ({ allowed: true }), now: Date.now },
    ...overrides,
  });
  const request = () => new Request("http://x/api/things", { headers: { "x-workspace-id": WORKSPACE_ID } });
  return { built, request, loadAppUser, resolveScopedWorkspace };
}

describe("Workspace actor resolution", () => {
  test("a warm request is answered by the single-read path and never loads the user or membership again", async () => {
    const readWorkspaceActor = mock(async () => ({ user, context }));
    const { built, request, loadAppUser, resolveScopedWorkspace } = runtime({ readWorkspaceActor });
    const actor = await built.actorsFor(request()).workspace();
    expect(actor).toMatchObject({ actorUserId: "user-1", workspaceId: WORKSPACE_ID, role: "editor" });
    expect(readWorkspaceActor).toHaveBeenCalledWith("clerk-1", WORKSPACE_ID);
    expect(loadAppUser).not.toHaveBeenCalled();
    expect(resolveScopedWorkspace).not.toHaveBeenCalled();
  });

  test("a null single read takes the full path, which provisions and decides", async () => {
    const readWorkspaceActor = mock(async () => null);
    const { built, request, loadAppUser, resolveScopedWorkspace } = runtime({ readWorkspaceActor });
    const actor = await built.actorsFor(request()).workspace();
    expect(actor?.workspaceId).toBe(WORKSPACE_ID);
    expect(loadAppUser).toHaveBeenCalledTimes(1);
    expect(resolveScopedWorkspace).toHaveBeenCalledTimes(1);
  });

  test("a removed selection is still a 409 after the full path refuses it", async () => {
    const { built, request } = runtime({ readWorkspaceActor: async () => null, resolveScopedWorkspace: async () => null });
    await expect(built.actorsFor(request()).workspace()).rejects.toMatchObject({
      failure: { code: "workspace_selection_changed", status: 409 },
    });
  });

  test("a membership of another App User from the single read is refused", async () => {
    const { built, request } = runtime({
      readWorkspaceActor: async () => ({ user, context: { ...context, userId: "someone-else" } }),
    });
    await expect(built.actorsFor(request()).workspace()).rejects.toMatchObject({
      failure: { code: "workspace_selection_changed" },
    });
  });

  test("an unauthenticated request reads nothing", async () => {
    const readWorkspaceActor = mock(async () => ({ user, context }));
    const { built, request, loadAppUser } = runtime({
      readWorkspaceActor,
      authenticate: async () => ({ status: "unauthenticated", reason: "missing_credential" }),
    });
    expect(await built.actorsFor(request()).workspace()).toBeNull();
    expect(readWorkspaceActor).not.toHaveBeenCalled();
    expect(loadAppUser).not.toHaveBeenCalled();
  });

  test("a non-UUID header is a 400 invalid_input before any read; a removed valid selection stays a 409", async () => {
    const readWorkspaceActor = mock(async () => ({ user, context }));
    const { built, loadAppUser, resolveScopedWorkspace } = runtime({ readWorkspaceActor, isWorkspaceHint: isWorkspaceId });
    const malformed = new Request("http://x/api/things", { headers: { "x-workspace-id": "not-a-uuid" } });
    await expect(built.actorsFor(malformed).workspace()).rejects.toMatchObject({
      failure: { code: "invalid_input", category: "validation", status: 400 },
    });
    expect(readWorkspaceActor).not.toHaveBeenCalled();
    expect(loadAppUser).not.toHaveBeenCalled();
    expect(resolveScopedWorkspace).not.toHaveBeenCalled();

    const removed = runtime({ isWorkspaceHint: isWorkspaceId, readWorkspaceActor: async () => null, resolveScopedWorkspace: async () => null });
    await expect(removed.built.actorsFor(removed.request()).workspace()).rejects.toMatchObject({
      failure: { code: "workspace_selection_changed", status: 409 },
    });
  });

  test("a malformed header does not outrank authentication", async () => {
    const { built } = runtime({ isWorkspaceHint: isWorkspaceId, authenticate: async () => ({ status: "unauthenticated", reason: "missing_credential" }) });
    const malformed = new Request("http://x/api/things", { headers: { "x-workspace-id": "nope" } });
    expect(await built.actorsFor(malformed).workspace()).toBeNull();
  });
});

describe("identity outcomes are not server errors", () => {
  class ClerkAPIResponseError extends Error {
    static kind = "ClerkAPIResponseError";
    status = 404;
  }

  test.each([
    ["a deleted Clerk identity", () => new ClerkIdentityDeletedError("clerk-1")],
    ["a Clerk 404", () => new ClerkAPIResponseError("not found")],
  ])("%s resolves to no actor, which admission answers as 401", async (_name, failure) => {
    const { built, request } = runtime({ loadAppUser: mock(async () => { throw failure(); }) });
    await expect(built.actorsFor(request()).workspace()).resolves.toBeNull();
  });

  test("an email owned by another live identity is a typed 409", async () => {
    const { built, request } = runtime({ loadAppUser: mock(async () => { throw new ClerkEmailConflictError("clerk-1"); }) });
    await expect(built.actorsFor(request()).workspace()).rejects.toMatchObject({ failure: { status: 409, code: "account_email_conflict" } });
  });

  test("an unrecognised failure is still an error", async () => {
    const { built, request } = runtime({ loadAppUser: mock(async () => { throw new Error("db down"); }) });
    await expect(built.actorsFor(request()).workspace()).rejects.toThrow("db down");
  });
});
