import { describe, expect, mock, test } from "bun:test";
import type { BrowserActorScope } from "../../http/request-policy-runtime";
import { readExplorer, readHome, readProjectDetail, readSourceGrant, type ProjectReadDeps } from "./read-models";
import { workspaceContext } from "./test-support";

function actor(overrides: Partial<ReturnType<typeof workspaceContext>> = {}): BrowserActorScope {
  const context = workspaceContext(overrides);
  return {
    actorUserId: "actor-user",
    workspaceId: context.workspaceId,
    workspaceOwnerUserId: context.workspaceOwnerUserId,
    role: context.role,
    status: context.status,
    pricingTier: context.pricingTier,
    isPersonalWorkspace: context.isPersonal,
    firstName: " Ada ",
    workspace: context,
  } as unknown as BrowserActorScope;
}

const page = { items: [{ id: "p1" }], nextCursor: null, totalCount: 1, statusCounts: { all: 1 } };

function fakes(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const track = <T>(name: string, value: T) =>
    mock(async (..._args: unknown[]) => {
      calls.push(name);
      return value;
    });
  const deps = {
    projectService: {
      getProjectSnapshot: track("snapshot", { project: { id: "p1", sourceStorageKey: "key" }, lastSeq: 4 }),
      getTranscriptSnapshot: track("transcript.full", { status: "completed" }),
      getTranscriptStatusSnapshot: track("transcript.status", { status: "queued", errorCode: null }),
      getLatestContentPack: track("contentPack", null),
      getWorkflowHistory: track("history", []),
      getUsageSummary: track("usage", { tier: "creator" }),
    },
    workspaceLibraryService: {
      listProjects: track("listProjects", page),
      listFolders: track("listFolders", [
        { id: "f1", name: "Launch", createdAt: new Date("2026-10-01T00:00:00Z"), _count: { projects: 2 } },
      ]),
    },
    clipService: { listClips: track("clips", []) },
    socialService: { listProjectPosts: track("posts", { items: [], nextCursor: null }) },
    socialOAuthService: { listAccounts: track("accounts", [{ id: "a1" }]) },
    analyticsService: { getProjectAnalytics: track("analytics", { views: 1 }) },
    dubbingService: {
      listProjectDubs: track("dubs", []),
      getDubbingAllowance: track("allowance", { used: 0, remaining: 3 }),
    },
    brandProfileService: {
      list: track("brands", [
        {
          id: "b1",
          name: "Brand",
          identity: { primaryLogoAssetId: "asset-1" },
          assets: [{ id: "asset-1", role: "logo", accessUrl: "https://assets/logo.png" }],
        },
      ]),
    },
    reviewService: { internalRoom: track("review", { rounds: [] }) },
    workspaceService: { getWorkspace: track("workspace", { timezone: "Europe/Paris" }) },
    autopilotService: { listRules: track("rules", [{ status: "active" }, { status: "paused" }]) },
    getProjectFinishing: track("finishing", null),
    getProcessingUsage: () => ({ projectCreditUsage: track("creditUsage", null) }),
    presignDownloadUrl: track("presign", "https://storage.example/source.mp4"),
    ...overrides,
  };
  return { deps: deps as unknown as ProjectReadDeps, calls };
}

describe("home aggregate", () => {
  test("loads the Autopilot rules only for someone who can create, and projects the card", async () => {
    const editor = fakes();
    const home = await readHome(editor.deps, actor({ role: "editor" }));
    expect(editor.calls).toContain("rules");
    expect(home).toMatchObject({
      firstName: "Ada",
      canCreate: true,
      readOnlyReason: null,
      canManageBilling: false,
      autopilot: { rules: 2, activeRules: 1 },
    });

    const viewer = fakes();
    const viewerHome = await readHome(viewer.deps, actor({ role: "viewer" }));
    expect(viewer.calls).not.toContain("rules");
    expect(viewerHome).toMatchObject({ canCreate: false, readOnlyReason: "viewer", autopilot: { rules: 0 } });
  });

  test("a paused Workspace is read-only for its owner", async () => {
    const home = await readHome(fakes().deps, actor({ role: "owner", status: "past_due" as never }));
    expect(home.readOnlyReason).toBe("paused");
    expect(home.canManageBilling).toBe(true);
  });
});

describe("explorer aggregate", () => {
  test("keeps every filter, pages with the cursor and names the active folder", async () => {
    const { deps } = fakes();
    const explorer = await readExplorer(deps, actor(), {
      q: "launch",
      status: "ready",
      source: "youtube",
      sort: "clips",
      folder: "f1",
      limit: 20,
      cursor: "abc",
    });
    expect(deps.workspaceLibraryService.listProjects).toHaveBeenCalledWith(expect.anything(), {
      folderId: "f1",
      query: "launch",
      status: "ready",
      source: "youtube",
      sort: "clips",
      limit: 20,
      cursor: "abc",
    });
    expect(explorer.page).toEqual(page);
    expect(explorer.folders).toEqual([
      { id: "f1", name: "Launch", createdAt: "2026-10-01T00:00:00.000Z", projectCount: 2 },
    ]);
    expect(explorer.activeFolder).toEqual({ id: "f1", name: "Launch" });
    expect(explorer.filters).toEqual({ q: "launch", status: "ready", source: "youtube", sort: "clips", folder: "f1" });
    expect(explorer.access).toMatchObject({ canEdit: true, canCreate: true });
  });

  test("an unknown folder is not an active folder", async () => {
    const explorer = await readExplorer(fakes().deps, actor({ role: "viewer" }), {
      q: "",
      status: "all",
      source: "all",
      sort: "newest",
      folder: "missing",
      limit: undefined,
      cursor: null,
    });
    expect(explorer.activeFolder).toBeNull();
    expect(explorer.access).toMatchObject({ canEdit: false, canCreate: false });
  });
});

describe("project detail aggregate", () => {
  test("the clips tab carries the brand choices and a source grant, and reads only the status of the transcript", async () => {
    const { deps, calls } = fakes();
    const detail = await readProjectDetail(deps, actor(), "p1", "clips");
    expect(detail?.tab).toBe("clips");
    expect(calls).toContain("transcript.status");
    expect(calls).not.toContain("transcript.full");
    expect(calls).not.toContain("analytics");
    expect(calls).not.toContain("review");
    expect(calls).not.toContain("dubs");
    expect(detail?.transcript.view).toBe("status");
    expect(detail?.tabData.brandChoices).toEqual([
      { id: "b1", name: "Brand", colors: { primaryLogoAssetId: "asset-1" }, logoUrl: "https://assets/logo.png" },
    ]);
    expect(detail?.tabData.sourceVideo?.url).toBe("https://storage.example/source.mp4");
    expect(detail?.tabData.socialAccounts).toEqual([{ id: "a1" }]);
    expect(detail?.tabData.workspaceTimezone).toBe("Europe/Paris");
    expect(detail?.snapshot.lastSeq).toBe(4);
  });

  test("only the transcript tab loads the full transcript", async () => {
    const { deps, calls } = fakes();
    const detail = await readProjectDetail(deps, actor(), "p1", "transcript");
    expect(calls).toContain("transcript.full");
    expect(calls).not.toContain("transcript.status");
    expect(detail?.transcript).toEqual({ view: "full", data: { status: "completed" } });
    expect(calls).not.toContain("brands");
    expect(calls).not.toContain("presign");
  });

  test("each other tab reads just its own data", async () => {
    for (const [tab, call] of [
      ["analytics", "analytics"],
      ["dubbing", "dubs"],
      ["review", "review"],
      ["posts", "accounts"],
    ] as const) {
      const { deps, calls } = fakes();
      await readProjectDetail(deps, actor(), "p1", tab);
      expect(calls).toContain(call);
      expect(calls).not.toContain("brands");
      expect(calls).not.toContain("presign");
    }
    const { deps, calls } = fakes();
    await readProjectDetail(deps, actor(), "p1", "activity");
    expect(calls).not.toContain("accounts");
    expect(calls).not.toContain("dubs");
    expect(calls).not.toContain("analytics");
  });

  test("a viewer opens the review room read-only", async () => {
    const { deps } = fakes();
    await readProjectDetail(deps, actor({ role: "viewer" }), "p1", "review");
    expect(deps.reviewService.internalRoom).toHaveBeenCalledWith("workspace-a", "p1", "view");
    const manager = fakes();
    await readProjectDetail(manager.deps, actor({ role: "owner" }), "p1", "review");
    expect(manager.deps.reviewService.internalRoom).toHaveBeenCalledWith("workspace-a", "p1", "manage");
  });

  test("every read starts before any of them settles", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const slow = (name: string, value: unknown) =>
      mock(async () => {
        order.push(`start:${name}`);
        await gate.promise;
        return value;
      });
    const { deps } = fakes({
      clipService: { listClips: slow("clips", []) },
      projectService: {
        getProjectSnapshot: slow("snapshot", { project: { id: "p1", sourceStorageKey: null }, lastSeq: 0 }),
        getTranscriptStatusSnapshot: slow("transcript", null),
        getLatestContentPack: slow("pack", null),
        getWorkflowHistory: slow("history", []),
        getUsageSummary: slow("usage", { tier: "creator" }),
      },
      socialService: { listProjectPosts: slow("posts", { items: [], nextCursor: null }) },
    });
    const pending = readProjectDetail(deps, actor(), "p1", "activity");
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(
      expect.arrayContaining([
        "start:snapshot",
        "start:clips",
        "start:transcript",
        "start:pack",
        "start:history",
        "start:usage",
        "start:posts",
      ]),
    );
    gate.resolve();
    expect(await pending).not.toBeNull();
  });

  test("a Project that vanished after admission yields nothing", async () => {
    const { deps } = fakes({
      projectService: {
        getProjectSnapshot: mock(async () => ({ project: null, lastSeq: 0 })),
        getTranscriptStatusSnapshot: mock(async () => null),
        getLatestContentPack: mock(async () => null),
        getWorkflowHistory: mock(async () => []),
        getUsageSummary: mock(async () => ({ tier: "creator" })),
      },
    });
    expect(await readProjectDetail(deps, actor(), "p1", "clips")).toBeNull();
  });
});

describe("source grant", () => {
  test("is null for a reclaimed source and when signing fails", async () => {
    const { deps } = fakes();
    expect(await readSourceGrant(deps, null)).toBeNull();
    const failing = { presignDownloadUrl: mock(async () => Promise.reject(new Error("r2 down"))) };
    expect(await readSourceGrant(failing as never, "key")).toBeNull();
  });

  test("expires an hour out", async () => {
    const { deps } = fakes();
    const before = Date.now();
    const grant = await readSourceGrant(deps, "key");
    expect(Date.parse(grant?.expiresAt ?? "") - before).toBeGreaterThanOrEqual(3_599_000);
  });
});
