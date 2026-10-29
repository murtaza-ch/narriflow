import { describe, expect, mock, test } from "bun:test";
import type { AppUser, WorkspaceActorContext } from "@narriflow/auth";
import {
  BrandProfileConflictError,
  BrandProfileNotFoundError,
  GeneratedMediaJobError,
} from "@narriflow/services";
import { Hono } from "hono";
import {
  installRequestPolicy,
  requireAdmissionDeclaration,
} from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { apiErrorHandler, apiNotFoundHandler, errorEnvelopeMiddleware } from "../../http/errors";
import { limitBody } from "../../http/limits";
import { apiRequestId } from "../../http/logging";
import { createRequestPolicyRuntime } from "../../http/request-policy-runtime";
import type { RateLimitCheck } from "../../http/request-policy";
import { requireJsonContentType } from "../../http/route";
import { brandAdmission } from "./admission";
import { type BrandRouteDeps, createBrandRoutes } from "./routes";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const WORKSPACE_ID = "workspace-a";

const user = { id: "actor-user", clerkId: "clerk-1", primaryEmail: "private@example.test" } as AppUser;

function context(overrides: Partial<WorkspaceActorContext> = {}): WorkspaceActorContext {
  return {
    userId: "actor-user",
    workspaceId: WORKSPACE_ID,
    workspaceName: "Workspace A",
    workspaceOwnerUserId: "owner-user",
    role: "owner",
    status: "active",
    pricingTier: "business",
    isPersonal: false,
    workspaceSelectionChanged: false,
    ...overrides,
  };
}

const profile = {
  id: PROFILE_ID,
  name: "Acme",
  slug: "acme",
  revision: 3,
  identity: {},
  voice: {},
  approvalRule: "none" as const,
  defaultTemplateId: null,
  defaultIntroSceneTemplateId: null,
  defaultOutroSceneTemplateId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  templates: [],
  assets: [],
  fonts: [],
  audio: [],
};

type Stubs = Record<string, Record<string, ReturnType<typeof mock>>>;

/** Every service method a brand route can call, as a recording stub. */
function stubs(): Stubs {
  return {
    profiles: {
      list: mock(async () => [profile]),
      listAll: mock(async () => [profile]),
      get: mock(async () => profile),
      create: mock(async () => profile),
      update: mock(async () => profile),
      setMembership: mock(async () => profile),
      setDefault: mock(async () => undefined),
      softDelete: mock(async () => undefined),
      getDefaultId: mock(async () => PROFILE_ID),
      usage: mock(async () => ({ [PROFILE_ID]: { isDefault: true, recipes: [{ id: "r1", name: "Weekly" }] } })),
      requireUsableId: mock(async () => PROFILE_ID),
      resolveProfileForTemplate: mock(async () => PROFILE_ID),
    },
    templates: {
      list: mock(async () => ({ builtIns: [], mine: [], defaultId: null })),
      get: mock(async () => ({ id: TEMPLATE_ID, name: "Style", captionPreset: { fontAsset: null } })),
      create: mock(async () => ({ id: TEMPLATE_ID })),
      update: mock(async () => ({ id: TEMPLATE_ID })),
      softDelete: mock(async () => undefined),
      setDefault: mock(async () => undefined),
      duplicate: mock(async () => ({ id: TEMPLATE_ID })),
      presignLogoUpload: mock(async () => ({ key: "k", uploadUrl: "https://upload.test/k", contentType: "image/png" })),
      getLogoDownloadUrl: mock(async () => null),
    },
    scenes: {
      list: mock(async () => []),
      create: mock(async () => ({ id: "scene" })),
      update: mock(async () => ({ id: "scene" })),
      softDelete: mock(async () => ({ ok: true })),
    },
    fonts: {
      list: mock(async () => []),
      resolveReferences: mock(async () => []),
      presignUpload: mock(async () => ({ key: "k", uploadUrl: "https://upload.test/k" })),
      finalizeUpload: mock(async () => ({ id: "font" })),
      softDelete: mock(async () => undefined),
    },
    visualAssets: {
      list: mock(async () => []),
      presignUpload: mock(async () => ({ key: "k", uploadUrl: "https://upload.test/k" })),
      finalizeUpload: mock(async () => ({ id: "asset" })),
      softDelete: mock(async () => undefined),
    },
    audioAssets: {
      listAssets: mock(async () => ({ assets: [], moodTags: [], nextOffset: null })),
      presignUpload: mock(async () => ({ key: "k", uploadUrl: "https://upload.test/k", contentType: "audio/mpeg" })),
      finalizeUpload: mock(async () => ({ id: "audio" })),
      getPlaybackSource: mock(async () => null),
      setFavorite: mock(async () => ({ id: "audio", favorited: true })),
      deleteUserAsset: mock(async () => undefined),
    },
    generatedMedia: {
      list: mock(async () => []),
      usageSummary: mock(async () => ({ used: 0 })),
      create: mock(async () => ({ id: JOB_ID })),
      get: mock(async () => ({ id: JOB_ID, status: "queued" })),
      cancel: mock(async () => ({ id: JOB_ID, status: "cancelled" })),
      deleteResult: mock(async () => undefined),
    },
    campaignOperations: {
      applySceneTemplate: mock(async () => ({ operationId: "op" })),
    },
  };
}

interface HarnessOptions {
  role?: WorkspaceActorContext["role"];
  tier?: string;
  rateLimit?: () => RateLimitCheck;
}

function harness(options: HarnessOptions = {}) {
  const services = stubs();
  const runtime = createRequestPolicyRuntime({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? ({ status: "authenticated", identity: { clerkUserId: "clerk-1", sessionId: "s" } } as never)
        : ({ status: "unauthenticated", reason: "missing_credential" } as const),
    loadAppUser: async () => user,
    resolveScopedWorkspace: async (_user, hint) =>
      hint === WORKSPACE_ID
        ? context({ role: options.role ?? "owner", pricingTier: options.tier ?? "business" })
        : null,
    staffAllowlist: new Set(),
    policy: {
      resolveProject: async () => ({ kind: "active", projectId: PROJECT_ID }),
      rateLimit: async () => options.rateLimit?.() ?? { allowed: true },
      now: () => 1_000,
    },
  });
  // The same middleware order as the application, around this domain alone.
  const firstParty = new Hono<ApiEnv>();
  firstParty.use("*", errorEnvelopeMiddleware());
  firstParty.use("*", limitBody("control"));
  firstParty.use("*", requireJsonContentType());
  firstParty.use("*", installRequestPolicy(runtime));
  firstParty.use("*", requireAdmissionDeclaration());
  firstParty.route("/", createBrandRoutes(services as unknown as BrandRouteDeps));
  const app = new Hono<ApiEnv>();
  app.use("*", apiRequestId());
  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);
  app.route("/api", firstParty);
  const request = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    return app.request(`/api${path}`, {
      ...rest,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      headers: {
        authorization: "Bearer good",
        "x-workspace-id": WORKSPACE_ID,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  };
  return { services, request };
}

describe("brand route registration", () => {
  test("the mounted routes and the admission table name the same operations", () => {
    const mounted = new Set(
      createBrandRoutes(stubs() as unknown as BrandRouteDeps).routes.map(
        (route) => `${route.method} ${route.path}`,
      ),
    );
    expect([...mounted].sort()).toEqual(Object.keys(brandAdmission).sort());
  });

  test("a parameter route never precedes the literal path it could swallow", () => {
    const order = createBrandRoutes(stubs() as unknown as BrandRouteDeps).routes.map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(order.indexOf("GET /brand-profiles/default")).toBeLessThan(order.indexOf("GET /brand-profiles/:id"));
    expect(order.indexOf("POST /brand-templates/logo/presign")).toBeLessThan(
      order.indexOf("POST /brand-templates/:id/duplicate"),
    );
  });

  test("keeps the existing capabilities and operation limits", () => {
    const entries = brandAdmission as Record<string, { capability?: string; rate?: unknown }>;
    expect(entries["POST /brand-templates"]?.capability).toBe("brand.manage");
    expect(entries["POST /brand-templates/:id/set-default"]?.capability).toBe("workspace.manage");
    expect(entries["GET /brand-fonts"]?.capability).toBe("content.view");
    expect(entries["POST /brand-fonts/presign-upload"]?.rate).toMatchObject({ prefix: "brand-font-presign", limit: 30 });
    expect(entries["POST /visual-assets/presign-upload"]?.rate).toMatchObject({ prefix: "visual-asset-presign", limit: 30 });
    expect(entries["POST /projects/:projectId/generated-media/jobs"]).toMatchObject({
      capability: "content.edit",
      rate: { prefix: "generated-image-create", limit: 10 },
    });
  });
});

describe("admission", () => {
  test("a signed-out request is refused before any service runs", async () => {
    const { services, request } = harness();
    const response = await request("/brand-kit", { headers: { authorization: "" } });
    expect(response.status).toBe(401);
    expect(services.profiles!.listAll).not.toHaveBeenCalled();
  });

  test("a viewer reads the Brand Kit but cannot create a profile", async () => {
    const { services, request } = harness({ role: "viewer" });
    expect((await request("/brand-kit")).status).toBe(200);
    const denied = await request("/brand-profiles", {
      method: "POST",
      json: { name: "Acme", slug: "acme" },
      headers: { "idempotency-key": "intent-1" },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "capability_denied" });
    expect(services.profiles!.create).not.toHaveBeenCalled();
  });

  test("the profile usage read is for managers, as the delete dialog is", async () => {
    const { request } = harness({ role: "viewer" });
    expect((await request(`/brand-profiles/${PROFILE_ID}/usage`)).status).toBe(403);
  });

  test("setting the default style keeps its workspace.manage capability", async () => {
    const { services, request } = harness({ role: "editor" });
    const response = await request(`/brand-templates/${TEMPLATE_ID}/set-default`, { method: "POST" });
    expect(response.status).toBe(403);
    expect(services.templates!.setDefault).not.toHaveBeenCalled();
  });
});

describe("literal paths and input", () => {
  test("/brand-profiles/default is not swallowed by /brand-profiles/:id", async () => {
    const { services, request } = harness();
    const response = await request("/brand-profiles/default?applicable=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profileId: PROFILE_ID });
    expect(services.profiles!.get).not.toHaveBeenCalled();
  });

  test("the applicable default is none once the plan no longer allows profiles", async () => {
    const { request } = harness({ tier: "free" });
    expect(await (await request("/brand-profiles/default?applicable=1")).json()).toEqual({ profileId: null });
    expect(await (await request("/brand-profiles/default")).json()).toEqual({ profileId: PROFILE_ID });
  });

  test("a malformed id is the common invalid-input refusal, not a driver error", async () => {
    const { services, request } = harness();
    const response = await request("/brand-profiles/not-a-uuid");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
    expect(services.profiles!.get).not.toHaveBeenCalled();
  });

  test("the ordinary profile list keeps its 24-row page and passes a cursor through", async () => {
    const { services, request } = harness();
    await request("/brand-profiles");
    expect(services.profiles!.list).toHaveBeenLastCalledWith(expect.anything(), {
      limit: 24,
      query: undefined,
      cursor: undefined,
      includeDeleted: false,
    });
    await request(`/brand-profiles?limit=50&query=ac&cursor=${PROFILE_ID}`);
    expect(services.profiles!.list).toHaveBeenLastCalledWith(expect.anything(), {
      limit: 50,
      query: "ac",
      cursor: PROFILE_ID,
      includeDeleted: false,
    });
  });

  test("services receive the brand slice of the actor, never the App User", async () => {
    const { services, request } = harness();
    await request("/brand-profiles");
    const scope = services.profiles!.list!.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(scope).sort()).toEqual([
      "actorUserId",
      "isPersonalWorkspace",
      "pricingTier",
      "role",
      "status",
      "workspaceId",
      "workspaceOwnerUserId",
    ]);
  });

  test("an asset delete without a body replaces nothing", async () => {
    const { services, request } = harness();
    const response = await request(`/visual-assets/${TEMPLATE_ID}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(services.visualAssets!.softDelete).toHaveBeenCalledWith(expect.anything(), TEMPLATE_ID, {});
  });

  test("a profile delete carries its revision and replacement", async () => {
    const { services, request } = harness();
    const response = await request(`/brand-profiles/${PROFILE_ID}`, {
      method: "DELETE",
      json: { revision: 3, replacementProfileId: TEMPLATE_ID },
    });
    expect(response.status).toBe(200);
    expect(services.profiles!.softDelete).toHaveBeenCalledWith(expect.anything(), PROFILE_ID, {
      revision: 3,
      replacementProfileId: TEMPLATE_ID,
    });
  });

  test("a stale profile revision is the service's conflict, in the common envelope", async () => {
    const { services, request } = harness();
    services.profiles!.update!.mockImplementation(async () => {
      throw new BrandProfileConflictError();
    });
    const response = await request(`/brand-profiles/${PROFILE_ID}`, { method: "PATCH", json: { revision: 1, name: "New" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "brand_profile_conflict" });
  });

  test("an unknown profile is a typed 404", async () => {
    const { services, request } = harness();
    services.profiles!.get!.mockImplementation(async () => {
      throw new BrandProfileNotFoundError();
    });
    const response = await request(`/brand-profiles/${PROFILE_ID}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "brand_profile_not_found" });
  });

  test("a malformed audio id keeps its legacy refusal", async () => {
    const { request } = harness();
    const response = await request("/audio-assets/nope/playback-url");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_audio_asset_id" });
  });
});

describe("retryable creates", () => {
  const create = (request: ReturnType<typeof harness>["request"], key?: string) =>
    request("/brand-profiles", {
      method: "POST",
      json: { name: "Acme", slug: "acme" },
      headers: key ? { "idempotency-key": key } : {},
    });

  test("a create without an Idempotency-Key is refused before the service", async () => {
    const { services, request } = harness();
    const response = await create(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
    expect(services.profiles!.create).not.toHaveBeenCalled();
  });

  test("the browser's key reaches the receipt unchanged", async () => {
    const { services, request } = harness();
    const response = await create(request, "intent-123");
    expect(response.status).toBe(201);
    expect(services.profiles!.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "Acme", slug: "acme" }),
      expect.objectContaining({ clientIdempotencyKey: "intent-123" }),
    );
  });

  test.each([
    ["profile", "/brand-profiles", { name: "Acme", slug: "acme" }, "profiles", "create"],
    ["style", "/brand-templates", { name: "Style", captionPreset: {} }, "templates", "create"],
    ["style duplicate", `/brand-templates/${TEMPLATE_ID}/duplicate`, {}, "templates", "duplicate"],
    ["scene", `/brand-profiles/${PROFILE_ID}/scene-templates`, null, "scenes", "create"],
  ] as const)("a %s create requires the key", async (_name, path, json) => {
    const { request } = harness();
    const response = await request(path, { method: "POST", json: json ?? {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "idempotency_key_required" });
  });

  // Sol wave-B B09: the service says when a command resolved to an earlier acceptance; the adapter reports it.
  test.each([
    ["profile", "/brand-profiles", { name: "Acme", slug: "acme" }, "profiles", "create"],
    ["style", "/brand-templates", { name: "Style", captionPreset: {} }, "templates", "create"],
    ["style duplicate", `/brand-templates/${TEMPLATE_ID}/duplicate`, {}, "templates", "duplicate"],
    ["scene", `/brand-profiles/${PROFILE_ID}/scene-templates`, {
      name: "Intro",
      role: "intro",
      definition: {
        schemaVersion: 1,
        durationSec: 2,
        content: { kind: "color", color: "#1D4ED8" },
        motion: { entrance: "none", exit: "none", durationSec: 0.5 },
      },
    }, "scenes", "create"],
  ] as const)("a replayed %s create carries Idempotent-Replayed, a first acceptance does not", async (_name, path, json, service, method) => {
    const { services, request } = harness();
    const stub = (services as Record<string, Record<string, ReturnType<typeof mock>>>)[service]![method]!;
    const post = () => request(path, { method: "POST", json, headers: { "idempotency-key": "intent-r" } });
    stub.mockImplementationOnce(async () => ({}));
    expect((await post()).headers.get("idempotent-replayed")).toBeNull();
    stub.mockImplementationOnce(async (...args: unknown[]) => {
      (args[args.length - 1] as { onReplay(): void }).onReplay();
      return {};
    });
    expect((await post()).headers.get("idempotent-replayed")).toBe("true");
  });

  test("an exhausted limiter refuses new work only when the receipt reaches acceptance", async () => {
    const { services, request } = harness({
      rateLimit: () => ({ allowed: false, retryAfterSeconds: 30, availability: "available" }),
    });
    // The service replays first; only a new acceptance runs `beforeAccept`.
    services.profiles!.create!.mockImplementation(async (_scope, _input, mutation) => {
      await (mutation as { beforeAccept: () => Promise<void> }).beforeAccept();
      return profile;
    });
    const response = await create(request, "intent-9");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
  });

  test("a replay is answered even while the limiter is exhausted", async () => {
    const { services, request } = harness({
      rateLimit: () => ({ allowed: false, retryAfterSeconds: 30, availability: "available" }),
    });
    // A replaying service never calls `beforeAccept`.
    const response = await create(request, "intent-9");
    expect(response.status).toBe(201);
    expect(services.profiles!.create).toHaveBeenCalledTimes(1);
  });

  test("an unavailable limiter pauses new work with 503 mutations_unavailable", async () => {
    const { services, request } = harness({ rateLimit: () => ({ allowed: true, availability: "unavailable" }) });
    services.profiles!.create!.mockImplementation(async (_scope, _input, mutation) => {
      await (mutation as { beforeAccept: () => Promise<void> }).beforeAccept();
      return profile;
    });
    const response = await create(request, "intent-9");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "mutations_unavailable" });
  });
});

describe("generated media", () => {
  const body = {
    projectId: PROJECT_ID,
    idempotencyKey: "generated-key-1",
    prompt: "A lighthouse at dusk",
    promptOrigin: "manual",
    aspectRatio: "9:16",
    style: "editorial",
  };

  test("acceptance stays the job's own key and answers 202", async () => {
    const { services, request } = harness();
    const response = await request(`/projects/${PROJECT_ID}/generated-media/jobs`, { method: "POST", json: body });
    expect(response.status).toBe(202);
    expect(services.generatedMedia!.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "generated-key-1" }),
    );
  });

  test("a body naming another Project is the job origin refusal", async () => {
    const { services, request } = harness();
    const response = await request(`/projects/${PROJECT_ID}/generated-media/jobs`, {
      method: "POST",
      json: { ...body, projectId: JOB_ID },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: new GeneratedMediaJobError("generated_media_origin_not_found").code });
    expect(services.generatedMedia!.create).not.toHaveBeenCalled();
  });

  test("the job list carries the Workspace image allowance", async () => {
    const { request } = harness();
    const response = await request(`/projects/${PROJECT_ID}/generated-media/jobs?clipId=${JOB_ID}`);
    expect(await response.json()).toEqual({ jobs: [], usage: { used: 0 } });
  });
});

describe("applying a scene template", () => {
  const apply = `/projects/${PROJECT_ID}/brand-profiles/${PROFILE_ID}/scene-templates/${TEMPLATE_ID}/apply`;
  const body = {
    templateFingerprint: "a".repeat(64),
    placement: "start",
    clips: [{ clipId: JOB_ID, expectedEditorRevision: 2 }],
  };

  test("keeps its campaign retry identity and key", async () => {
    const { services, request } = harness();
    const response = await request(apply, {
      method: "POST",
      json: body,
      headers: { "idempotency-key": "apply-1", "campaign-retry-of": JOB_ID },
    });
    expect(response.status).toBe(200);
    expect(services.campaignOperations!.applySceneTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, idempotencyKey: "apply-1", retryOfId: JOB_ID }),
      PROFILE_ID,
      TEMPLATE_ID,
      body,
    );
  });

  test("needs the campaign's Idempotency-Key", async () => {
    const { request } = harness();
    expect((await request(apply, { method: "POST", json: body })).status).toBe(400);
  });
});
