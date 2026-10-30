import { describe, expect, mock, test } from "bun:test";
import { ExpectedDomainFailureError } from "@narriflow/services";
import { buildGenerationContentPack } from "@narriflow/validators";
import { Hono } from "hono";
import type { ApiEnv } from "../../http/env";
import { checkRouteInventory } from "../../route-inventory";
import { libraryAdmission } from "../library/admission";
import { createLibraryRoutes, type LibraryRouteDeps } from "../library/routes";
import type { AdmissionEntry } from "../platform/admission-table";
import { projectsAdmission } from "./admission";
import { createProjectsRoutes, type ProjectsRouteDeps } from "./routes";
import { createProjectsWebhookRoutes, type ProjectsWebhookDeps } from "./webhooks";
import { mountDomain, PROJECT_ID, policyRuntime, signedInHeaders, workspaceContext } from "./test-support";

function projectsApp(deps: Record<string, unknown>, runtimeOptions: Parameters<typeof policyRuntime>[0] = {}) {
  return mountDomain(createProjectsRoutes(deps as unknown as ProjectsRouteDeps), policyRuntime(runtimeOptions));
}

const json = { ...signedInHeaders, "content-type": "application/json" };

describe("literal routes before parameter routes", () => {
  test("/projects/explorer is the explorer aggregate, not a Project called explorer", async () => {
    const listProjects = mock(async () => ({ items: [], nextCursor: null, totalCount: 0, statusCounts: {} }));
    const app = projectsApp({
      workspaceLibraryService: { listProjects, listFolders: mock(async () => []) },
    });
    const response = await app.request("/api/projects/explorer?q=%20hi%20&status=bogus&sort=title&limit=abc", {
      headers: signedInHeaders,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filters: { q: "hi", status: "all", sort: "title" } });
    expect(listProjects).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ query: "hi", status: "all", limit: undefined }));
  });
});

describe("project controls", () => {
  test("delete treats an already-deleted Project as done and passes other refusals through", async () => {
    const deleteProject = mock(async () => {
      throw Object.assign(new Error("gone"), { code: "project_not_found" });
    });
    const url = `/api/projects/${PROJECT_ID}`;
    const gone = await projectsApp({ projectService: { deleteProject } }).request(url, { method: "DELETE", headers: signedInHeaders });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ ok: true });

    const busy = mock(async () => {
      throw new ExpectedDomainFailureError({
        code: "project_has_active_workflow",
        kind: "conflict",
        message: "This project has a run in progress.",
      });
    });
    const refused = await projectsApp({ projectService: { deleteProject: busy } }).request(url, {
      method: "DELETE",
      headers: signedInHeaders,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "project_has_active_workflow" });
  });

  test("a viewer cannot delete, move, brand or change notifications", async () => {
    const viewer = { context: workspaceContext({ role: "viewer" }) };
    const deleteProject = mock(async () => undefined);
    const app = projectsApp({ projectService: { deleteProject, setProjectNotifyPreference: mock() } }, viewer);
    const base = `/api/projects/${PROJECT_ID}`;
    const attempts = [
      app.request(base, { method: "DELETE", headers: signedInHeaders }),
      app.request(`${base}/folder`, { method: "PATCH", headers: json, body: JSON.stringify({ folderId: null }) }),
      app.request(`${base}/notify-preference`, { method: "PUT", headers: json, body: JSON.stringify({ notifyOnComplete: true }) }),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(403);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  test("an inaccessible Project is concealed before any service runs", async () => {
    const getProjectSnapshot = mock();
    const app = projectsApp({ projectService: { getProjectSnapshot } }, { projectAccessible: false });
    const response = await app.request(`/api/projects/${PROJECT_ID}/detail`, { headers: signedInHeaders });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "project_not_found" });
    expect(getProjectSnapshot).not.toHaveBeenCalled();
  });

  test("notify preference, folder move and brand apply validate input and call the service with the path Project", async () => {
    const setProjectNotifyPreference = mock(async () => undefined);
    const moveProject = mock(async () => undefined);
    const applyToProject = mock(async () => undefined);
    const app = projectsApp({
      projectService: { setProjectNotifyPreference },
      workspaceLibraryService: { moveProject },
      brandProfileService: { applyToProject },
    });
    const base = `/api/projects/${PROJECT_ID}`;

    const bad = await app.request(`${base}/notify-preference`, { method: "PUT", headers: json, body: JSON.stringify({ notifyOnComplete: "yes" }) });
    expect(bad.status).toBe(400);
    expect(setProjectNotifyPreference).not.toHaveBeenCalled();

    const notify = await app.request(`${base}/notify-preference`, { method: "PUT", headers: json, body: JSON.stringify({ notifyOnComplete: true }) });
    expect(notify.status).toBe(200);
    expect(setProjectNotifyPreference).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a" }), PROJECT_ID, true);

    const folderId = "22222222-2222-4222-8222-222222222222";
    const move = await app.request(`${base}/folder`, { method: "PATCH", headers: json, body: JSON.stringify({ folderId }) });
    expect(move.status).toBe(200);
    expect(moveProject).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, folderId);
    const notAFolder = await app.request(`${base}/folder`, { method: "PATCH", headers: json, body: JSON.stringify({ folderId: "nope" }) });
    expect(notAFolder.status).toBe(400);

    const profileId = "33333333-3333-4333-8333-333333333333";
    const brand = await app.request(`${base}/brand-profile`, { method: "POST", headers: json, body: JSON.stringify({ profileId, templateId: null }) });
    expect(brand.status).toBe(200);
    expect(applyToProject).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, { profileId, templateId: null });
  });

  test("a plan refusal on generation reaches the client as a typed error with its details", async () => {
    const triggerGeneration = mock(async () => {
      throw new ExpectedDomainFailureError({
        code: "processing_credits_exhausted",
        kind: "payment_required",
        message: "Out of credits.",
        details: { remainingCredits: 0 },
      });
    });
    const app = projectsApp({ projectService: { triggerGeneration } });
    const response = await app.request(`/api/projects/${PROJECT_ID}/generate`, {
      method: "POST",
      headers: { ...json, "idempotency-key": "k-1" },
      body: JSON.stringify({ contentPack: buildGenerationContentPack() }),
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: "processing_credits_exhausted",
      details: { remainingCredits: 0 },
    });
    expect(triggerGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-a" }),
      PROJECT_ID,
      expect.objectContaining({ forceRegenerate: false, languageCode: null }),
      "k-1",
    );

    const invalidPack = await app.request(`/api/projects/${PROJECT_ID}/generate`, {
      method: "POST",
      headers: { ...json, "idempotency-key": "k-2" },
      body: JSON.stringify({ contentPack: "nope" }),
    });
    expect(invalidPack.status).toBe(400);
    expect(triggerGeneration).toHaveBeenCalledTimes(1);
  });
});

describe("project reads", () => {
  test("transcript view=status returns only the status; the default view stays the full snapshot", async () => {
    const getTranscriptStatusSnapshot = mock(async () => ({ status: "processing", errorCode: null }));
    const getTranscriptSnapshot = mock(async () => ({ status: "completed", utterances: [] }));
    const app = projectsApp({ projectService: { getTranscriptStatusSnapshot, getTranscriptSnapshot } });
    const status = await app.request(`/api/projects/${PROJECT_ID}/transcript?view=status`, { headers: signedInHeaders });
    expect(await status.json()).toEqual({ view: "status", transcript: { status: "processing", errorCode: null } });
    expect(getTranscriptSnapshot).not.toHaveBeenCalled();
    const full = await app.request(`/api/projects/${PROJECT_ID}/transcript`, { headers: signedInHeaders });
    expect(await full.json()).toEqual({ status: "completed", utterances: [] });
    const invalid = await app.request(`/api/projects/${PROJECT_ID}/transcript?view=everything`, { headers: signedInHeaders });
    expect(invalid.status).toBe(400);
  });

  test("standalone reads return the same named fields as the detail aggregate", async () => {
    const app = projectsApp({
      projectService: {
        getLatestContentPack: mock(async () => ({ id: "pack" })),
        getWorkflowHistory: mock(async () => [{ seq: 1 }]),
        getProjectSnapshot: mock(async () => ({ project: { sourceStorageKey: null }, lastSeq: 1 })),
      },
      getProjectFinishing: mock(async () => null),
      getProcessingUsage: () => ({ projectCreditUsage: mock(async () => ({ spentCredits: 3 })) }),
      dubbingService: { getDubbingAllowance: mock(async () => ({ remaining: 2 })) },
      presignDownloadUrl: mock(),
    });
    const read = async (path: string) => (await app.request(`/api/projects/${PROJECT_ID}/${path}`, { headers: signedInHeaders })).json();
    expect(await read("content-pack")).toEqual({ contentPack: { id: "pack" } });
    expect(await read("workflow-history")).toEqual({ workflowHistory: [{ seq: 1 }] });
    expect(await read("finishing")).toEqual({ finishing: null });
    expect(await read("credit-usage")).toEqual({ creditUsage: { spentCredits: 3 } });
    expect(await read("dubs/allowance")).toEqual({ allowance: { remaining: 2 } });
    expect(await read("source-url")).toEqual({ url: null, expiresAt: null });
  });

  test("the detail aggregate defaults an unknown tab to clips and answers 404 when the Project is gone", async () => {
    const getProjectSnapshot = mock(async () => ({ project: null, lastSeq: 0 }));
    const app = projectsApp({
      projectService: {
        getProjectSnapshot,
        getTranscriptStatusSnapshot: mock(async () => null),
        getLatestContentPack: mock(async () => null),
        getWorkflowHistory: mock(async () => []),
        getUsageSummary: mock(async () => ({ tier: "creator" })),
      },
      clipService: { listClips: mock(async () => []) },
      socialService: { listProjectPosts: mock(async () => ({ items: [], nextCursor: null })) },
      socialOAuthService: { listAccounts: mock(async () => []) },
      workspaceService: { getWorkspace: mock(async () => null) },
      brandProfileService: { list: mock(async () => []) },
      getProjectFinishing: mock(async () => null),
      getProcessingUsage: () => ({ projectCreditUsage: mock(async () => null) }),
      presignDownloadUrl: mock(),
    });
    const response = await app.request(`/api/projects/${PROJECT_ID}/detail?tab=nonsense`, { headers: signedInHeaders });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "project_not_found" });
  });
});

describe("route registration", () => {
  test("the projects and library domains register exactly their declarations, with no literal swallowed by :id", () => {
    const app = new Hono<ApiEnv>();
    app.route("/api", createProjectsRoutes({} as unknown as ProjectsRouteDeps));
    app.route("/api", createProjectsWebhookRoutes({} as unknown as ProjectsWebhookDeps));
    app.route("/api", createLibraryRoutes({} as unknown as LibraryRouteDeps));
    const declared = new Map<string, AdmissionEntry>();
    for (const table of [projectsAdmission, libraryAdmission]) {
      for (const [key, entry] of Object.entries(table) as [string, AdmissionEntry][]) {
        const [method, path] = key.split(" ") as [string, string];
        declared.set(`${method} /api${path}`, entry);
      }
    }
    const report = checkRouteInventory(app, declared);
    expect(report.problems).toEqual([]);
    expect(report.checkedRoutes).toBe(declared.size);
  });
});
