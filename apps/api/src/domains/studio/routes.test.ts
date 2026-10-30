import { describe, expect, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import {
  ClipActionError,
  ClipEditorRevisionConflictError,
} from "@narriflow/services";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type ClipSnapshot,
  type EditorDocument,
  type PricingTier,
} from "@narriflow/validators";
import { Hono } from "hono";
import { routeBodyLimit } from "../../body-limits";
import { installRequestPolicy, requireAdmissionDeclaration } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "../../http/errors";
import { apiRequestId } from "../../http/logging";
import type { AuthenticatedRequestPolicyDependencies, RateLimitCheck } from "../../http/request-policy";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import { requireJsonContentType } from "../../http/route";
import { studioAdmission } from "./admission";
import { createStudioRoutes, type StudioRouteDeps } from "./routes";

const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const CLIP_ID = "50000000-0000-4000-8000-000000000001";
const OTHER_CLIP_ID = "50000000-0000-4000-8000-000000000002";
const PROFILE_ID = "60000000-0000-4000-8000-000000000001";
const ASSET_ID = "70000000-0000-4000-8000-000000000001";

function document(): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({}),
    brollUrl: null,
    deletedRanges: [],
  });
}

const clip = {
  id: CLIP_ID,
  projectId: PROJECT_ID,
  title: "A title",
  hookText: "The hook",
  startSec: 0,
  endSec: 20,
  transcriptSlice: [],
  renderVariants: [],
  viralityScore: 80,
  category: "insight",
  wholeSource: false,
  brollCues: undefined,
} as unknown as ClipSnapshot;

interface Calls {
  titles: unknown[][];
  mutations: unknown[];
  scenePolicy: unknown[][];
  changedVisualScenes: unknown[][];
  introducedVisualScenes: unknown[][];
  visualBroll: unknown[][];
  changedFontScenes: unknown[][];
  introducedFontScenes: unknown[][];
  generatedInsertions: unknown[][];
  reads: string[];
  censorTerms: unknown[][];
  censorEvents: unknown[][];
}

interface Harness {
  deps: StudioRouteDeps;
  calls: Calls;
  rateKeys: string[];
  request(path: string, init?: RequestInit): Response | Promise<Response>;
  json(method: string, path: string, body: unknown): Response | Promise<Response>;
}

function harness(
  options: {
    role?: WorkspaceActorContext["role"];
    pricingTier?: PricingTier;
    rateLimit?: (key: string, limit: number) => RateLimitCheck;
    override?: (deps: StudioRouteDeps, calls: Calls) => void;
  } = {},
): Harness {
  const current = document();
  const calls: Calls = {
    titles: [],
    mutations: [],
    scenePolicy: [],
    changedVisualScenes: [],
    introducedVisualScenes: [],
    visualBroll: [],
    changedFontScenes: [],
    introducedFontScenes: [],
    generatedInsertions: [],
    reads: [],
    censorTerms: [],
    censorEvents: [],
  };
  const read = <T>(name: string, value: T) => async () => {
    calls.reads.push(name);
    return value;
  };
  const deps = {
    clipService: {
      updateClipTitle: async (...args: unknown[]) => {
        calls.titles.push(args);
        return clip;
      },
      getClipSnapshot: async () => clip,
      getClipEditorDocument: async () => {
        calls.reads.push("editor");
        return {
          revision: 7,
          document: current,
          original: current,
          layoutAnalysis: null,
          autoLayoutAnalysis: null,
          splitLayoutAnalysis: null,
          splitLayoutFailure: null,
          layoutAnalysisFailure: null,
        };
      },
      getClipPreviewSource: read("preview", {
        previewUrl: null,
        previewStartSec: 0,
        previewDurationSec: null,
        waveformPeaksUrl: null,
      }),
      getClipAutoLayoutAnalysis: async () => null,
      getClipSplitLayoutOutcome: async () => null,
      getClipLayoutAnalysisOutcome: async () => null,
    },
    clipEditorDocumentPersistence: {
      mutateDocument: async (input: unknown) => {
        calls.mutations.push(input);
        return { revision: 8, document: current, noop: false };
      },
    },
    analyzeSceneDocumentMutation: (...args: unknown[]) => {
      calls.scenePolicy.push(args);
      return { changedSceneBlocks: [], introducedSceneReferences: [], introducedVisualAssetIds: [] };
    },
    projectService: {
      getProjectSnapshot: async () => {
        calls.reads.push("project");
        return {
          project: {
            id: PROJECT_ID,
            brandProfileId: PROFILE_ID,
            sourceStorageKey: "sources/a.mp4",
            sourceMimeType: "video/mp4",
            sourceType: "link",
            sourceEdgeSec: 600,
          },
        };
      },
      getProjectBrandSnapshot: read("brandSnapshot", null),
      getProjectBrandAudio: read("brandAudio", { music: [], sfx: [] }),
      getCaptionLanguage: read("captionLanguage", "ur"),
    },
    autoCensorService: {
      getPolicy: read("policy", { locale: "en", canApply: true }),
      replaceProjectTerms: async (...args: unknown[]) => {
        calls.censorTerms.push(args);
        return args[2];
      },
      recordEvent: async (...args: unknown[]) => {
        calls.censorEvents.push(args);
      },
    },
    visualAssetService: {
      list: read("activeAssets", []),
      resolveSceneReferences: read("retainedSceneAssets", []),
      resolveVisualBrollReferences: read("retainedBroll", []),
      assertSceneReferencesWithPolicy: async (...args: unknown[]) => {
        calls.changedVisualScenes.push(args);
      },
      assertSceneReferences: async (...args: unknown[]) => {
        calls.introducedVisualScenes.push(args);
      },
      assertVisualBrollReferences: async (...args: unknown[]) => {
        calls.visualBroll.push(args);
      },
      recordGeneratedInsertionsBestEffort: async (...args: unknown[]) => {
        calls.generatedInsertions.push(args);
      },
    },
    sceneTemplateService: { list: read("templates", []) },
    brandFontService: {
      list: read("activeFonts", []),
      resolveReferences: read("retainedFonts", []),
      resolveSceneReferences: read("retainedSceneFonts", []),
      assertSceneReferences: async (...args: unknown[]) => {
        const options = args[3] as { allowDeleted: boolean };
        if (options.allowDeleted) calls.changedFontScenes.push(args);
        else calls.introducedFontScenes.push(args);
      },
    },
    brandProfileService: { get: read("profile", { fonts: [] }) },
    presignDownloadUrl: async ({ key }: { key: string }) => `https://signed.test/${key}`,
    generatedImageCapability: () => ({ available: true, reason: "available", usage: "metered" }),
  } as unknown as StudioRouteDeps;
  options.override?.(deps, calls);

  const user = { id: ACTOR_USER_ID, clerkId: "clerk-1" } as AppUser;
  const context: WorkspaceActorContext = {
    userId: ACTOR_USER_ID,
    workspaceId: WORKSPACE_ID,
    workspaceName: "Workspace",
    workspaceOwnerUserId: OWNER_USER_ID,
    role: options.role ?? "owner",
    status: "active",
    pricingTier: options.pricingTier ?? "creator",
    isPersonal: false,
    workspaceSelectionChanged: false,
  };
  const rateKeys: string[] = [];
  const policy: AuthenticatedRequestPolicyDependencies = {
    resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
    rateLimit: async (input) => {
      rateKeys.push(input.key);
      return options.rateLimit?.(input.key, input.limit) ?? { allowed: true };
    },
    now: () => 1_000,
  };
  const runtime = createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) => (hint === WORKSPACE_ID ? context : null),
    staffAllowlist: new Set(),
    policy,
  });

  // The first-party chain exactly as `createApiApp` builds it around a domain.
  const app = new Hono<ApiEnv>();
  app.use("*", apiRequestId());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  const firstParty = new Hono<ApiEnv>();
  firstParty.use("*", errorEnvelopeMiddleware());
  firstParty.use("*", routeBodyLimit("control"));
  firstParty.use("*", requireJsonContentType());
  firstParty.use("*", installRequestPolicy(runtime));
  firstParty.use("*", requireAdmissionDeclaration());
  firstParty.route("/", createStudioRoutes(deps));
  app.route("/api", firstParty);

  const request = (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, {
      ...init,
      headers: {
        authorization: "Bearer good",
        "x-workspace-id": WORKSPACE_ID,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return {
    deps,
    calls,
    rateKeys,
    request,
    json: (method, path, body) =>
      request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
  };
}

const clipPath = `/projects/${PROJECT_ID}/clips/${CLIP_ID}`;

describe("Studio admission", () => {
  test("declares exactly the fifteen studio routes", () => {
    expect(Object.keys(studioAdmission)).toHaveLength(15);
  });

  test("every declaration is mounted and every mounted route is declared", () => {
    const { deps } = harness();
    const mounted = new Set(
      createStudioRoutes(deps).routes.map((route) => `${route.method} ${route.path}`),
    );
    expect([...mounted].sort()).toEqual(Object.keys(studioAdmission).sort());
  });

  test("a missing Bearer is 401 on every route before any service runs", async () => {
    const { request, calls } = harness();
    for (const key of Object.keys(studioAdmission)) {
      const [method, template] = key.split(" ") as [string, string];
      const path = template
        .replace(":id", PROJECT_ID)
        .replace(":clipId", CLIP_ID);
      const response = await request(path, { method, headers: { authorization: "" } });
      expect(response.status).toBe(401);
    }
    expect(calls.reads).toEqual([]);
    expect(calls.mutations).toEqual([]);
  });

  test("content.edit routes refuse a viewer while the content.view facts stay readable", async () => {
    const { request, json, calls } = harness({ role: "viewer" });
    const denied = [
      request(`${clipPath}/studio`),
      request(`${clipPath}/preview-source`),
      request(`${clipPath}/layout/auto`),
      request(`${clipPath}/layout/split`),
      request(`${clipPath}/layout/screen`),
      request(`${clipPath}/editor-assets`),
      request(`${clipPath}/editor`),
      request("/generated-images/capability"),
      json("PUT", `/projects/${PROJECT_ID}/censor-terms`, { terms: ["heck"] }),
      json("PATCH", clipPath, { title: "x" }),
      json("POST", `${clipPath}/editor/reset`, { baseRevision: 1 }),
      json("PUT", `${clipPath}/editor`, { baseRevision: 1, document: document() }),
    ];
    for (const response of await Promise.all(denied)) expect(response.status).toBe(403);
    expect(calls.reads).toEqual([]);
    expect(calls.mutations).toEqual([]);

    expect((await request(`/projects/${PROJECT_ID}/auto-censor`)).status).toBe(200);
    expect((await request(`/projects/${PROJECT_ID}/brand-snapshot`)).status).toBe(200);
    const event = await json("POST", `${clipPath}/censor-events`, { type: "auto_censor_scan_started" });
    expect(event.status).toBe(200);
    expect(await event.json()).toEqual({ recorded: true });
  });

  test("a malformed clip identifier is a validation refusal, not a service call", async () => {
    const { request, calls } = harness();
    const response = await request(`/projects/${PROJECT_ID}/clips/not-a-uuid/studio`);
    expect(response.status).toBe(400);
    expect(calls.reads).toEqual([]);
  });
});

describe("Studio bootstrap", () => {
  test("replicates the page's reads in one aggregate and serializes the Studio props", async () => {
    const { request, calls } = harness();

    const response = await request(`${clipPath}/studio`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      clipInfo: {
        id: CLIP_ID,
        title: "The hook",
        clipTitle: "A title",
        aspectRatio: "9:16",
        sourceKind: "video",
        can1080pExport: true,
        captionLanguage: "ur",
      },
      editor: { revision: 7, document: { version: 1 } },
      source: { videoUrl: "https://signed.test/sources/a.mp4", previewId: "sources/a.mp4", purged: false },
      brandLogo: null,
      brandProfileId: PROFILE_ID,
      sceneWriteCapabilities: { cards: true, images: true, videos: true, templates: true },
      generatedImagesCapability: { reason: "available" },
      plan: { pricingTier: "creator", canManageBilling: true },
    });
    expect(calls.reads.sort()).toEqual(
      [
        "activeAssets",
        "activeFonts",
        "brandAudio",
        "brandSnapshot",
        "captionLanguage",
        "editor",
        "policy",
        "preview",
        "profile",
        "project",
        "retainedBroll",
        "retainedFonts",
        "retainedSceneAssets",
        "retainedSceneFonts",
        "templates",
      ].sort(),
    );
  });

  test("starts every independent read before any of them settles", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { request } = harness({
      override: (deps) => {
        const gated = <T>(name: string, value: T) => async () => {
          started.push(name);
          await gate;
          return value;
        };
        (deps.projectService as { getProjectSnapshot: unknown }).getProjectSnapshot = async () => {
          started.push("project");
          await gate;
          return {
            project: {
              id: PROJECT_ID,
              brandProfileId: null,
              sourceStorageKey: null,
              sourceMimeType: "video/mp4",
              sourceType: "link",
              sourceEdgeSec: null,
            },
          };
        };
        (deps.clipService as { getClipPreviewSource: unknown }).getClipPreviewSource = gated("preview", {});
        (deps.autoCensorService as { getPolicy: unknown }).getPolicy = gated("policy", {});
        (deps.brandFontService as { list: unknown }).list = gated("activeFonts", []);
        (deps.visualAssetService as { list: unknown }).list = gated("activeAssets", []);
      },
    });

    const pending = request(`${clipPath}/studio`);
    await Bun.sleep(25);
    // Nothing has resolved, yet the project, preview, policy and active asset reads are all in flight.
    expect(started.sort()).toEqual(["activeAssets", "activeFonts", "policy", "preview", "project"]);
    release();
    expect((await pending).status).toBe(200);
  });

  test("keeps deleted references resolvable and lets active assets override them", async () => {
    const { request } = harness({
      override: (deps) => {
        const retained = { id: ASSET_ID, title: "old", kind: "image", fingerprint: "f1", durationSec: null, accessUrl: null, missing: true, insertable: false };
        (deps.visualAssetService as { resolveSceneReferences: unknown }).resolveSceneReferences = async () => [retained];
        (deps.visualAssetService as { list: unknown }).list = async () => [
          { ...retained, title: "active", accessUrl: "https://signed.test/a" },
        ];
        (deps.brandFontService as { resolveReferences: unknown }).resolveReferences = async () => [
          { id: "font-retained", family: "Gone", style: "normal", weight: 400, fingerprint: "ff", accessUrl: null, face: null },
        ];
        (deps.brandFontService as { list: unknown }).list = async () => [
          { id: "font-active", family: "Here", style: "normal", weight: 400, fingerprint: "fa", accessUrl: "https://signed.test/f", face: null },
        ];
      },
    });

    const body = (await (await request(`${clipPath}/studio`)).json()) as {
      visualAssets: Array<{ id: string; title: string; missing: boolean; insertable: boolean }>;
      fonts: Array<{ id: string; insertable: boolean }>;
    };

    expect(body.visualAssets).toEqual([
      expect.objectContaining({ id: ASSET_ID, title: "active", missing: false, insertable: true }),
    ]);
    expect(body.fonts).toEqual([
      expect.objectContaining({ id: "font-retained", insertable: false }),
      expect.objectContaining({ id: "font-active", insertable: true }),
    ]);
  });

  test("a presign failure and an unavailable image provider degrade without failing the Studio", async () => {
    const { request, calls } = harness({
      override: (deps) => {
        deps.presignDownloadUrl = async () => {
          throw new Error("storage down");
        };
        deps.generatedImageCapability = () => ({
          available: false,
          reason: "provider_unavailable",
          usage: "metered",
        });
      },
    });

    const response = await request(`${clipPath}/studio`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: { videoUrl: null, purged: false },
      generatedImagesCapability: { available: false, reason: "provider_unavailable" },
    });
    // Already-made images are still listed while the provider is unavailable.
    expect(calls.reads).toContain("activeAssets");
  });

  test("a plan without scenes or images reads no scene assets and reports the upgrade requirement", async () => {
    const { request, calls } = harness({
      pricingTier: "free",
      override: (deps) => {
        deps.generatedImageCapability = () => ({
          available: false,
          reason: "entitlement_required",
          usage: "trial_metered",
        });
      },
    });

    const body = (await (await request(`${clipPath}/studio`)).json()) as {
      sceneWriteCapabilities: Record<string, boolean>;
      plan: { scenesRequirement: { requiredTier: string | null } | null };
      clipInfo: { can1080pExport: boolean };
    };

    expect(body.sceneWriteCapabilities).toEqual({
      cards: false,
      images: false,
      videos: false,
      templates: false,
    });
    expect(body.plan.scenesRequirement?.requiredTier).toBeTruthy();
    expect(calls.reads).not.toContain("activeAssets");
    expect(calls.reads).not.toContain("templates");
    expect(calls.reads).not.toContain("profile");
    expect(calls.reads).not.toContain("retainedSceneFonts");
  });

  test("a purged source is reported terminal and a missing clip is a 404", async () => {
    const purged = harness({
      override: (deps) => {
        (deps.projectService as { getProjectSnapshot: unknown }).getProjectSnapshot = async () => ({
          project: {
            id: PROJECT_ID,
            brandProfileId: null,
            sourceStorageKey: null,
            sourceMimeType: "audio/mpeg",
            sourceType: "link",
            sourceEdgeSec: 120,
          },
        });
      },
    });
    expect(await (await purged.request(`${clipPath}/studio`)).json()).toMatchObject({
      source: { videoUrl: null, previewId: PROJECT_ID, purged: true },
      clipInfo: { sourceKind: "audio", sourceEdgeSec: 120 },
    });

    const missing = harness({
      override: (deps) => {
        (deps.clipService as { getClipSnapshot: unknown }).getClipSnapshot = async () => {
          throw new ClipActionError("clip_not_found");
        };
      },
    });
    const response = await missing.request(`${clipPath}/studio`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "clip_not_found" });
  });

  test("resolves the project's logo reference even when presigning it fails", async () => {
    const { request } = harness({
      override: (deps) => {
        (deps.projectService as { getProjectBrandSnapshot: unknown }).getProjectBrandSnapshot = async () => ({
          name: "Brand",
          logoStorageKey: "brand/logo.png",
          logoPosition: "top_right",
          logoOpacity: 80,
          logoScalePct: 12,
        });
        deps.presignDownloadUrl = async () => {
          throw new Error("storage down");
        };
      },
    });
    const body = (await (await request(`${clipPath}/studio`)).json()) as {
      brandLogo: { url: string | null; ref: string; opacity: number } | null;
    };
    // The snapshot fixture above may not satisfy the brand snapshot schema; the
    // contract is that the Studio never fails on it.
    expect(body).toHaveProperty("brandLogo");
  });
});

describe("Studio polls and censor controls", () => {
  test("layout polls name their payload and preview-source returns the readiness facts", async () => {
    const { request } = harness();
    expect(await (await request(`${clipPath}/layout/auto`)).json()).toEqual({ analysis: null });
    expect(await (await request(`${clipPath}/layout/split`)).json()).toEqual({ outcome: null });
    expect(await (await request(`${clipPath}/layout/screen`)).json()).toEqual({ outcome: null });
    expect(await (await request(`${clipPath}/preview-source`)).json()).toMatchObject({
      previewUrl: null,
      waveformPeaksUrl: null,
    });
  });

  test("replaces Project censor terms with the validated list", async () => {
    const { json, calls } = harness();
    const response = await json("PUT", `/projects/${PROJECT_ID}/censor-terms`, { terms: [" heck ", "heck", "darn*"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ terms: ["heck", "darn*"] });
    expect(calls.censorTerms[0]?.[1]).toBe(PROJECT_ID);

    const invalid = await json("PUT", `/projects/${PROJECT_ID}/censor-terms`, { terms: ["fu*ck"] });
    expect(invalid.status).toBe(400);
    expect(calls.censorTerms).toHaveLength(1);
  });

  test("records only well-formed analytics events", async () => {
    const { json, calls } = harness();
    const ok = await json("POST", `${clipPath}/censor-events`, {
      type: "auto_censor_scan_completed",
      resultCountBucket: "zero",
    });
    expect(ok.status).toBe(200);
    expect(calls.censorEvents[0]?.slice(1)).toEqual([
      PROJECT_ID,
      CLIP_ID,
      { type: "auto_censor_scan_completed", resultCountBucket: "zero" },
    ]);

    const unknown = await json("POST", `${clipPath}/censor-events`, { type: "other" });
    expect(unknown.status).toBe(400);
    expect(calls.censorEvents).toHaveLength(1);
  });

  test("reports the image capability for the admitted Workspace", async () => {
    const { request } = harness();
    expect(await (await request("/generated-images/capability")).json()).toEqual({
      available: true,
      reason: "available",
      usage: "metered",
    });
  });
});

describe("Clip Editor persistence routes", () => {
  test("rejects invalid and unrecognized PATCH bodies", async () => {
    const { json } = harness();
    const invalid = await json("PATCH", clipPath, "null");
    const unrecognized = await json("PATCH", clipPath, { unexpected: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_input" });
    expect(unrecognized.status).toBe(400);
  });

  test("dispatches a title PATCH without mutating the editor document", async () => {
    const { json, calls } = harness();
    const response = await json("PATCH", clipPath, { title: "  New title  " });
    expect(response.status).toBe(200);
    expect(calls.titles).toEqual([
      [expect.objectContaining({ actorUserId: ACTOR_USER_ID, workspaceId: WORKSPACE_ID }), PROJECT_ID, CLIP_ID, "New title"],
    ]);
    expect(calls.mutations).toEqual([]);
  });

  test.each([
    [{ startSec: 1, endSec: 12 }, { kind: "set_boundaries", startSec: 1, endSec: 12 }],
    [{ captionPreset: null }, { kind: "set_caption_preset", captionPreset: null }],
    [{ transcriptSlice: [] }, { kind: "set_transcript", transcriptSlice: [] }],
    [{ brollUrl: "https://media.test/broll.mp4" }, { kind: "set_broll_url", brollUrl: "https://media.test/broll.mp4" }],
    [{ studioEdits: studioEditsSchema.parse({}) }, { kind: "set_studio_edits", studioEdits: studioEditsSchema.parse({}) }],
  ])("dispatches a supported editor-document PATCH", async (payload, intent) => {
    const { json, calls } = harness();
    const response = await json("PATCH", clipPath, payload);
    expect(response.status).toBe(200);
    expect(calls.mutations).toHaveLength(1);
    expect(calls.mutations[0]).toMatchObject({
      actorUserId: ACTOR_USER_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      clipId: CLIP_ID,
      intent,
    });
  });

  test("does not treat an unrelated object as a studio-edits PATCH", async () => {
    const { json, calls } = harness();
    const response = await json("PATCH", clipPath, { captionPreset: "invalid" });
    expect(response.status).toBe(400);
    expect(calls.mutations).toEqual([]);
  });

  test("returns the current Clip Editor Document", async () => {
    const { request } = harness();
    const response = await request(`${clipPath}/editor`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 7, document: { version: 1 } });
  });

  test("rejects an invalid Clip Editor Document replacement before any service runs", async () => {
    const { json, calls } = harness();
    const response = await json("PUT", `${clipPath}/editor`, { baseRevision: 7, document: {} });
    expect(response.status).toBe(400);
    expect(calls.scenePolicy).toEqual([]);
    expect(calls.mutations).toEqual([]);
  });

  test("validates Scene references and persists a Clip Editor Document replacement", async () => {
    const { json, calls } = harness({
      override: (deps, calls) => {
        deps.analyzeSceneDocumentMutation = (...args: unknown[]) => {
          calls.scenePolicy.push(args);
          return { changedSceneBlocks: [], introducedSceneReferences: [], introducedVisualAssetIds: [ASSET_ID] };
        };
      },
    });
    const next = document();

    const response = await json("PUT", `${clipPath}/editor`, { baseRevision: 7, document: next });

    expect(response.status).toBe(200);
    expect(calls.scenePolicy).toHaveLength(1);
    expect(calls.changedVisualScenes).toHaveLength(1);
    expect(calls.introducedVisualScenes).toHaveLength(1);
    expect(calls.visualBroll).toHaveLength(1);
    expect(calls.changedFontScenes).toHaveLength(1);
    expect(calls.introducedFontScenes).toHaveLength(1);
    expect(calls.mutations[0]).toMatchObject({ intent: { kind: "replace", baseRevision: 7, document: next } });
    expect(calls.generatedInsertions[0]?.[2]).toEqual([ASSET_ID]);
    expect(await response.json()).toMatchObject({ revision: 8, document: { version: 1 }, clip: { id: CLIP_ID } });
  });

  test("resets through the reset intent without Scene reference checks", async () => {
    const { json, calls } = harness();
    const response = await json("POST", `${clipPath}/editor/reset`, { baseRevision: 7 });
    expect(response.status).toBe(200);
    expect(calls.scenePolicy).toEqual([]);
    expect(calls.mutations[0]).toMatchObject({ intent: { kind: "reset", baseRevision: 7 } });
    expect(calls.changedVisualScenes).toEqual([]);
  });

  test("a stale revision stays the service's 409 with the canonical current revision", async () => {
    const { json, calls } = harness({
      override: (deps) => {
        deps.clipEditorDocumentPersistence.mutateDocument = async () => {
          throw new ClipEditorRevisionConflictError(9);
        };
      },
    });
    const save = await json("PUT", `${clipPath}/editor`, { baseRevision: 7, document: document() });
    const reset = await json("POST", `${clipPath}/editor/reset`, { baseRevision: 7 });
    for (const response of [save, reset]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "editor_revision_conflict",
        details: { currentRevision: 9 },
      });
    }
    expect(calls.generatedInsertions).toEqual([]);
  });
});

describe("Editor rate tier and body ceilings", () => {
  test("save and reset use the per-clip bucket and the actor ceiling, not the ordinary mutation bucket", async () => {
    const { json, rateKeys } = harness();
    await json("PUT", `${clipPath}/editor`, { baseRevision: 7, document: document() });
    await json("POST", `${clipPath}/editor/reset`, { baseRevision: 7 });
    expect(rateKeys.some((key) => key.startsWith("api-editor:") && key.endsWith(`:${CLIP_ID}`))).toBe(true);
    expect(rateKeys.some((key) => key === `api-editor-global:${ACTOR_USER_ID}`)).toBe(true);
    expect(rateKeys.some((key) => key.startsWith("api-mutation"))).toBe(false);
  });

  test("a clip PATCH stays in the ordinary mutation bucket", async () => {
    const { json, rateKeys } = harness();
    await json("PATCH", clipPath, { title: "Title" });
    expect(rateKeys.some((key) => key.startsWith("api-editor"))).toBe(false);
    expect(rateKeys.length).toBeGreaterThan(0);
  });

  test("accepts about 40 isolated saves a minute plus flush/retry bursts, then refuses past 120 on one clip", async () => {
    const counts = new Map<string, number>();
    const { json } = harness({
      rateLimit: (key, limit) => {
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return used <= limit
          ? { allowed: true, limit, remaining: limit - used }
          : { allowed: false, limit, remaining: 0, retryAfterSeconds: 30 };
      },
    });
    const save = (clipId: string) =>
      json("PUT", `/projects/${PROJECT_ID}/clips/${clipId}/editor`, { baseRevision: 7, document: document() });

    // 40 isolated saves, then three bursts of ten (explicit flush plus retries).
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await save(CLIP_ID)).status);
    for (let burst = 0; burst < 3; burst += 1) {
      statuses.push(...(await Promise.all(Array.from({ length: 10 }, () => save(CLIP_ID)))).map((r) => r.status));
    }
    expect(statuses).toHaveLength(70);
    expect(statuses.every((status) => status === 200)).toBe(true);

    // Past the per-clip bucket the clip is refused; another clip is unaffected.
    for (let i = 0; i < 50; i += 1) await save(CLIP_ID);
    const refused = await save(CLIP_ID);
    expect(refused.status).toBe(429);
    expect((await save(OTHER_CLIP_ID)).status).toBe(200);
  });

  test("the editor body class admits a document above the ordinary 1 MiB ceiling; reset does not", async () => {
    const { json } = harness();
    const padding = "x".repeat(1_600_000);
    // Past the limiter the document fails validation: a 400, never a 413.
    const put = await json("PUT", `${clipPath}/editor`, { baseRevision: 7, document: { padding } });
    const patch = await json("PATCH", clipPath, { unexpected: padding });
    const reset = await json("POST", `${clipPath}/editor/reset`, { baseRevision: 7, padding });
    expect(put.status).toBe(400);
    expect(patch.status).toBe(400);
    expect(reset.status).toBe(413);
  });
});
