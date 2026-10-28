import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { createInventoryApp } from "../../test-app";
import { type ExportsRouteDeps, createExportsRoutes } from "./routes";

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const CLIP_ID = "40000000-0000-4000-8000-000000000002";
const EXPORT_ID = "40000000-0000-4000-8000-000000000003";
const VARIANT_ID = "40000000-0000-4000-8000-000000000004";
const BUNDLE_ID = "40000000-0000-4000-8000-000000000005";
const WEB = "http://localhost:3000";
const user = { id: "actor-user", clerkId: "clerk-1" } as AppUser;

function context(role: WorkspaceActorContext["role"]): WorkspaceActorContext {
  return {
    userId: "actor-user",
    workspaceId: "workspace-a",
    workspaceName: "Workspace A",
    workspaceOwnerUserId: "owner-user",
    role,
    status: "active",
    pricingTier: "creator",
    isPersonal: false,
    workspaceSelectionChanged: false,
  };
}

function appWith(
  deps: Partial<ExportsRouteDeps>,
  options: { role?: WorkspaceActorContext["role"]; rateAllowed?: boolean } = {},
) {
  const policyRuntime = createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) =>
      hint === "workspace-a" ? context(options.role ?? "editor") : null,
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
      rateLimit: async () => ({
        allowed: options.rateAllowed ?? true,
        availability: "available",
        retryAfterSeconds: 30,
        limit: 12,
        remaining: 5,
      }),
      now: () => 1_000,
    },
  });
  return createInventoryApp({
    policyRuntime,
    domains: { exports: createExportsRoutes(deps as ExportsRouteDeps) },
  });
}

const headers = { authorization: "Bearer good", "x-workspace-id": "workspace-a", origin: WEB };
const request = (app: ReturnType<typeof appWith>, path: string, init: RequestInit = {}) =>
  app.request(path, { headers, ...init });

describe("Workspace exports list", () => {
  const page = { items: [], nextCursor: null };

  test("maps the URL filters onto the library query and shapes the page for the browser", async () => {
    const listExports = mock(async () => ({ items: [], nextCursor: "next" }));
    const presentWorkspaceExports = mock(async () => page);
    const app = appWith({
      workspaceLibraryService: { listExports } as never,
      clipExportService: { presentWorkspaceExports } as never,
    });
    const response = await request(
      app,
      `/api/workspace/exports?status=processing&q=launch&project=${PROJECT_ID}&ratio=ratio_9_16&from=2026-10-01&to=2026-10-31&cursor=abc`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(page);
    expect(listExports.mock.calls[0]).toMatchObject([
      { actorUserId: "actor-user", workspaceId: "workspace-a" },
      {
        status: "processing",
        query: "launch",
        projectId: PROJECT_ID,
        aspectRatio: "ratio_9_16",
        from: new Date("2026-10-01T00:00:00.000Z"),
        to: new Date("2026-10-31T23:59:59.999Z"),
        cursor: "abc",
      },
    ]);
    expect(presentWorkspaceExports).toHaveBeenCalledTimes(1);
  });

  test.each(["status=all", "ratio=16:9", "from=yesterday", "project=not-a-uuid"])(
    "refuses a malformed filter (%s) before the service",
    async (query) => {
      const listExports = mock(async () => page);
      const app = appWith({ workspaceLibraryService: { listExports } as never });
      const response = await request(app, `/api/workspace/exports?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_input" });
      expect(listExports).not.toHaveBeenCalled();
    },
  );

  test("signed-out callers are refused and the project filter list needs a session too", async () => {
    const app = appWith({});
    expect((await app.request("/api/workspace/exports", { headers: { origin: WEB } })).status).toBe(401);
    expect((await app.request("/api/workspace/export-projects", { headers: { origin: WEB } })).status).toBe(401);
  });

  test("lists the projects that have exports", async () => {
    const listExportProjects = mock(async () => [{ id: PROJECT_ID, title: "Launch" }]);
    const app = appWith({ workspaceLibraryService: { listExportProjects } as never });
    const response = await request(app, "/api/workspace/export-projects");
    expect(await response.json()).toEqual({ projects: [{ id: PROJECT_ID, title: "Launch" }] });
  });
});

describe("download grants", () => {
  test("a Workspace export file is a JSON grant, never a redirect", async () => {
    const grant = {
      exportId: EXPORT_ID,
      variantId: VARIANT_ID,
      fileName: "clip.mp4",
      sizeBytes: 10,
      downloadUrl: "https://files.example/clip.mp4?sig=1",
      expiresAt: "2026-10-29T10:15:00.000Z",
    };
    const issueWorkspaceDownloadGrant = mock(async () => grant);
    const app = appWith({ clipExportService: { issueWorkspaceDownloadGrant } as never });
    const response = await request(app, `/api/workspace/exports/${EXPORT_ID}/download?variant=${VARIANT_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(grant);
    expect(issueWorkspaceDownloadGrant.mock.calls[0]).toMatchObject([
      { actorUserId: "actor-user", workspaceId: "workspace-a" },
      EXPORT_ID,
      VARIANT_ID,
    ]);
  });

  test("a malformed export or variant id never reaches the service", async () => {
    const issueWorkspaceDownloadGrant = mock(async () => ({}));
    const app = appWith({ clipExportService: { issueWorkspaceDownloadGrant } as never });
    expect((await request(app, "/api/workspace/exports/nope/download")).status).toBe(400);
    expect((await request(app, `/api/workspace/exports/${EXPORT_ID}/download?variant=nope`)).status).toBe(400);
    expect(issueWorkspaceDownloadGrant).not.toHaveBeenCalled();
  });

  test("a bundle download is a JSON grant too", async () => {
    const getExportBundleDownload = mock(async () => "https://files.example/bundle.zip?sig=2");
    const app = appWith({ campaignOperationService: { getExportBundleDownload } as never });
    const response = await request(app, `/api/projects/${PROJECT_ID}/export-bundles/${BUNDLE_ID}/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ downloadUrl: "https://files.example/bundle.zip?sig=2" });
  });
});

describe("Workspace export retry", () => {
  const url = `/api/workspace/exports/${EXPORT_ID}/retry`;
  const post = { method: "POST" };

  test("retries through the service and answers 202", async () => {
    const retryWorkspaceExport = mock(async () => ({ id: EXPORT_ID, status: "queued" }));
    const app = appWith({ clipExportService: { retryWorkspaceExport } as never });
    const response = await request(app, url, post);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: EXPORT_ID, status: "queued" });
    expect(retryWorkspaceExport.mock.calls[0]).toMatchObject([
      { actorUserId: "actor-user", workspaceId: "workspace-a" },
      EXPORT_ID,
    ]);
  });

  test("a viewer cannot spend credits", async () => {
    const retryWorkspaceExport = mock(async () => ({}));
    const app = appWith({ clipExportService: { retryWorkspaceExport } as never }, { role: "viewer" });
    expect((await request(app, url, post)).status).toBe(403);
    expect(retryWorkspaceExport).not.toHaveBeenCalled();
  });

  test("keeps the retry limit", async () => {
    const retryWorkspaceExport = mock(async () => ({}));
    const app = appWith({ clipExportService: { retryWorkspaceExport } as never }, { rateAllowed: false });
    expect((await request(app, url, post)).status).toBe(429);
    expect(retryWorkspaceExport).not.toHaveBeenCalled();
  });
});

describe("export detail", () => {
  const path = `/api/projects/${PROJECT_ID}/clips/${CLIP_ID}/exports/${EXPORT_ID}`;

  test("carries the Project's workflow cursor", async () => {
    const getOwned = mock(async () => ({ id: EXPORT_ID, status: "rendering" }));
    const getLastWorkflowSeq = mock(async () => 41);
    const app = appWith({ clipExportService: { getOwned } as never, getLastWorkflowSeq });
    const response = await request(app, path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: EXPORT_ID, status: "rendering", lastSeq: 41 });
    expect(getLastWorkflowSeq).toHaveBeenCalledWith(PROJECT_ID);
  });

  test("a missing export is 404 export_not_found", async () => {
    const app = appWith({
      clipExportService: { getOwned: mock(async () => null) } as never,
      getLastWorkflowSeq: mock(async () => 0),
    });
    const response = await request(app, path);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "export_not_found" });
  });
});

describe("attachments", () => {
  const clipPath = `/api/projects/${PROJECT_ID}/clips/${CLIP_ID}`;

  test("a timeline ZIP keeps its type, file name and editor revision", async () => {
    const archive = mock(async () => ({
      bytes: new Uint8Array([80, 75, 3, 4]),
      fileName: "clip-fcpxml.zip",
      editorRevision: 7,
    }));
    const app = appWith({ clipTimelineService: { archive } as never });
    const response = await request(app, `${clipPath}/timeline/fcpxml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="clip-fcpxml.zip"');
    expect(response.headers.get("x-editor-revision")).toBe("7");
  });

  test("subtitles keep their type and file name", async () => {
    const getSubtitles = mock(async () => [{ format: "srt", content: "1\n", fileName: "clip.srt" }]);
    const app = appWith({ clipExportService: { getSubtitles } as never });
    const response = await request(app, `${clipPath}/exports/${EXPORT_ID}/subtitles/srt`);
    expect(response.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="clip.srt"');
    expect(await response.text()).toBe("1\n");
  });
});
