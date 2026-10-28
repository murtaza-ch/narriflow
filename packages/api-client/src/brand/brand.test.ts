import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/query-core";
import { type ApiTransport, scopedKey, type WorkspaceScope } from "../core";
import { brandMutations } from "./mutations";
import { brandQueries, invalidateBrand } from "./queries";

const scope: WorkspaceScope = { userId: "user-1", workspaceId: "workspace-1" };
const ID = "11111111-1111-4111-8111-111111111111";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recording(respond: (call: Call) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const bound = {
    baseUrl: "https://api.example.test",
    async fetch(input: string | URL, init?: RequestInit) {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return Response.json(respond(call));
    },
  };
  const scopes: WorkspaceScope[] = [];
  const transport = {
    baseUrl: bound.baseUrl,
    scoped(target: WorkspaceScope) {
      scopes.push(target);
      return bound;
    },
  } as unknown as ApiTransport;
  return { calls, scopes, api: { transport, scope } };
}

async function run<T>(options: { queryFn?: unknown }): Promise<T> {
  const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<T>;
  return queryFn({ signal: new AbortController().signal });
}

describe("brand queries", () => {
  test("every key starts with the identity and Workspace, then the brand domain", () => {
    const { api } = recording();
    const queries = brandQueries(api);
    const keys = [
      queries.kit(),
      queries.profiles({ limit: 10 }),
      queries.defaultProfile({ applicable: true }),
      queries.profileDetail(ID, "scenes"),
      queries.profileUsage(ID),
      queries.templateEditorAssets(ID),
      queries.audioAssets({ kind: "music" }),
      queries.generatedJobs(ID),
    ].map((options) => options.queryKey as unknown[]);
    for (const key of keys) expect(key.slice(0, 4)).toEqual(["nf", "user-1", "workspace-1", "brand"]);
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
  });

  test("reads call the intended endpoints through the Workspace-bound transport", async () => {
    const { api, calls, scopes } = recording();
    const queries = brandQueries(api);
    await run(queries.kit());
    await run(queries.defaultProfile({ applicable: true }));
    await run(queries.profileDetail(ID, "styles"));
    await run(queries.profileUsage(ID));
    await run(queries.templateEditorAssets(ID));
    await run(queries.profiles({ limit: 50, query: "ac" }));
    await run(queries.audioAssets({ kind: "sfx", favorited: true, offset: 30 }));
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual([
      "GET /api/brand-kit",
      "GET /api/brand-profiles/default?applicable=1",
      `GET /api/brand-profiles/${ID}/detail?section=styles`,
      `GET /api/brand-profiles/${ID}/usage`,
      `GET /api/brand-templates/${ID}/editor-assets`,
      "GET /api/brand-profiles?limit=50&query=ac",
      "GET /api/audio-assets?kind=sfx&favorited=true&offset=30",
    ]);
    expect(scopes.every((bound) => bound === scope)).toBe(true);
  });

  test("the default read without `applicable` asks for the stored default", async () => {
    const { api, calls } = recording();
    await run(brandQueries(api).defaultProfile());
    expect(new URL(calls[0]!.url).search).toBe("");
  });

  test("signed links are never kept for reuse", () => {
    const { api } = recording();
    const queries = brandQueries(api);
    for (const options of [queries.templateLogoUrl(ID), queries.audioPlaybackUrl(ID)]) {
      expect(options.staleTime).toBe(0);
      expect(options.gcTime).toBeLessThanOrEqual(30_000);
    }
  });

  test("generated image jobs are polled only while one can still change", () => {
    const { api } = recording();
    const poll = brandQueries(api).generatedJobs(ID).refetchInterval as (query: unknown) => number | false;
    const withJobs = (statuses: string[]) => ({
      state: { data: { jobs: statuses.map((status) => ({ status })) } },
    });
    expect(poll(withJobs(["completed", "running"]))).toBe(3_000);
    expect(poll(withJobs(["completed", "failed", "cancelled", "rejected"]))).toBe(false);
    expect(poll({ state: { data: undefined } })).toBe(false);
    const single = brandQueries(api).generatedJob(ID, ID).refetchInterval as (query: unknown) => number | false;
    expect(single({ state: { data: { status: "queued" } } })).toBe(3_000);
    expect(single({ state: { data: { status: "completed" } } })).toBe(false);
  });
});

describe("brand mutations", () => {
  test("a retryable create sends the intent's key and body unchanged on every attempt", async () => {
    const { api, calls } = recording();
    const mutations = brandMutations(api);
    await mutations.createProfile({ name: "Acme", slug: "acme" }, "intent-1");
    await mutations.createProfile({ name: "Acme", slug: "acme" }, "intent-1");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.headers["idempotency-key"]).toBe("intent-1");
      expect(call.body).toEqual({ name: "Acme", slug: "acme" });
    }
  });

  test.each([
    ["style", (m: ReturnType<typeof brandMutations>) => m.createTemplate({ name: "S", captionPreset: {} } as never, "k"), "/api/brand-templates"],
    ["duplicate", (m: ReturnType<typeof brandMutations>) => m.duplicateTemplate(ID, {}, "k"), `/api/brand-templates/${ID}/duplicate`],
    ["scene", (m: ReturnType<typeof brandMutations>) => m.createScene(ID, {} as never, "k"), `/api/brand-profiles/${ID}/scene-templates`],
  ])("a %s create carries its key", async (_name, call, path) => {
    const { api, calls } = recording();
    await call(brandMutations(api));
    expect(new URL(calls[0]!.url).pathname).toBe(path);
    expect(calls[0]!.headers["idempotency-key"]).toBe("k");
  });

  test("a revision-guarded edit carries no idempotency key", async () => {
    const { api, calls } = recording();
    await brandMutations(api).updateProfile(ID, { revision: 2, name: "New" });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ revision: 2, name: "New" });
  });

  test("deleting a profile sends its revision and replacement as the body", async () => {
    const { api, calls } = recording();
    await brandMutations(api).deleteProfile(ID, { revision: 3, replacementProfileId: ID });
    expect(calls[0]).toMatchObject({ method: "DELETE", body: { revision: 3, replacementProfileId: ID } });
  });

  test("applying a scene names its campaign retry identity", async () => {
    const { api, calls } = recording();
    await brandMutations(api).applySceneTemplate(
      { projectId: ID, profileId: ID, templateId: ID },
      { templateFingerprint: "a".repeat(64), placement: "start", clips: [] } as never,
      { idempotencyKey: "apply-1", retryOfId: ID },
    );
    expect(calls[0]!.headers["idempotency-key"]).toBe("apply-1");
    expect(calls[0]!.headers["campaign-retry-of"]).toBe(ID);
  });

  test("a generated image keeps its own key in the body, with no header added", async () => {
    const { api, calls } = recording();
    await brandMutations(api).createGeneratedImage(ID, { projectId: ID, idempotencyKey: "job-key-1" } as never);
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ idempotencyKey: "job-key-1" });
  });
});

describe("invalidateBrand", () => {
  test("marks brand reads and dependent aggregates stale inside one Workspace only", async () => {
    const queryClient = new QueryClient();
    const other: WorkspaceScope = { userId: "user-1", workspaceId: "workspace-2" };
    const seed = (target: WorkspaceScope, domain: Parameters<typeof scopedKey>[1], resource: string) =>
      queryClient.setQueryData(scopedKey(target, domain, resource) as unknown[], { seeded: true });
    seed(scope, "brand", "kit");
    seed(scope, "recipes", "list");
    seed(scope, "ingest", "configuration");
    seed(scope, "ingest", "resume");
    seed(scope, "studio", "editor-assets");
    seed(scope, "studio", "bootstrap");
    seed(other, "brand", "kit");
    await invalidateBrand(queryClient, scope);
    const stale = (target: WorkspaceScope, domain: Parameters<typeof scopedKey>[1], resource: string) =>
      queryClient.getQueryState(scopedKey(target, domain, resource) as unknown[])?.isInvalidated;
    expect(stale(scope, "brand", "kit")).toBe(true);
    expect(stale(scope, "recipes", "list")).toBe(true);
    expect(stale(scope, "ingest", "configuration")).toBe(true);
    expect(stale(scope, "studio", "editor-assets")).toBe(true);
    // A Studio working document is never refetched by a brand edit.
    expect(stale(scope, "studio", "bootstrap")).toBe(false);
    expect(stale(scope, "ingest", "resume")).toBe(false);
    expect(stale(other, "brand", "kit")).toBe(false);
  });
});
