import { describe, expect, mock, test } from "bun:test";
import { recipesAdmission } from "./admission";
import { createDomainTestApp, signedInHeaders as signedIn } from "../ingest/test-app";
import { createRecipesRoutes, type RecipesRouteDeps } from "./routes";

const RECIPE_ID = "11111111-1111-4111-8111-111111111111";

function app(deps: Partial<RecipesRouteDeps>, limiterAllows = true) {
  return createDomainTestApp("recipes", createRecipesRoutes(deps as RecipesRouteDeps), { rateLimitAllows: limiterAllows });
}

const body = JSON.stringify({
  name: "Weekly",
  contentPack: {
    outputTypes: ["short_clip"],
    clipCountTarget: 10,
    clipDurationSecTarget: 45,
    toneConstraints: [],
    platformPlaybookVersion: "platform-playbook-v1",
    mode: "clip",
  },
});

describe("Recipe routes", () => {
  test("create and duplicate declare the 30 per hour Workspace limit and defer its refusal past replay", () => {
    for (const key of ["POST /recipes", "POST /recipes/:recipeId/duplicate"] as const) {
      expect(recipesAdmission[key]).toMatchObject({
        deferRateRefusal: true,
        rate: { scope: "workspace", prefix: "recipe-create", limit: 30, windowSeconds: 3600 },
      });
    }
  });

  test("a create needs its Idempotency-Key and reports a replay", async () => {
    const create = mock(async (_actor: unknown, _input: unknown, mutation: { clientIdempotencyKey: string }) => ({
      recipe: { id: RECIPE_ID, name: "Weekly" },
      replayed: mutation.clientIdempotencyKey === "k-replay",
    }));
    const routes = app({ recipesCommands: { create } as never });

    const noKey = await routes.request("/api/recipes", { method: "POST", headers: signedIn, body });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "idempotency_key_required" });
    expect(create).not.toHaveBeenCalled();

    const fresh = await routes.request("/api/recipes", { method: "POST", headers: { ...signedIn, "idempotency-key": "k-new" }, body });
    expect(fresh.status).toBe(201);
    expect(fresh.headers.get("idempotent-replayed")).toBeNull();

    const replay = await routes.request("/api/recipes", { method: "POST", headers: { ...signedIn, "idempotency-key": "k-replay" }, body });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ actorUserId: "actor-user", workspaceId: "workspace-a" });
  });

  test("an exhausted limiter refuses new work only, after the replay lookup", async () => {
    const create = mock(async (_actor: unknown, _input: unknown, mutation: { clientIdempotencyKey: string; beforeAccept?: () => Promise<void> }) => {
      if (mutation.clientIdempotencyKey === "k-replay") return { recipe: { id: RECIPE_ID }, replayed: true };
      await mutation.beforeAccept?.();
      return { recipe: { id: RECIPE_ID }, replayed: false };
    });
    const routes = app({ recipesCommands: { create } as never }, false);
    const replay = await routes.request("/api/recipes", { method: "POST", headers: { ...signedIn, "idempotency-key": "k-replay" }, body });
    expect(replay.status).toBe(201);
    const fresh = await routes.request("/api/recipes", { method: "POST", headers: { ...signedIn, "idempotency-key": "k-new" }, body });
    expect(fresh.status).toBe(429);
  });

  test("duplicate takes the same key contract", async () => {
    const duplicate = mock(async () => ({ recipe: { id: RECIPE_ID }, replayed: false }));
    const routes = app({ recipesCommands: { duplicate } as never });
    const noKey = await routes.request(`/api/recipes/${RECIPE_ID}/duplicate`, { method: "POST", headers: signedIn });
    expect(noKey.status).toBe(400);
    const keyed = await routes.request(`/api/recipes/${RECIPE_ID}/duplicate`, { method: "POST", headers: { ...signedIn, "idempotency-key": "k-1" } });
    expect(keyed.status).toBe(201);
    expect(duplicate.mock.calls[0]?.[1]).toBe(RECIPE_ID);
  });

  test("list, update and delete keep the service's answers", async () => {
    const recipeService = {
      list: async () => [{ id: RECIPE_ID }],
      update: mock(async () => ({ id: RECIPE_ID, warnings: [] })),
      delete: mock(async () => undefined),
    };
    const routes = app({ recipeService: recipeService as never });
    expect(await (await routes.request("/api/recipes", { headers: signedIn })).json()).toEqual({ recipes: [{ id: RECIPE_ID }] });
    const patched = await routes.request(`/api/recipes/${RECIPE_ID}`, { method: "PATCH", headers: signedIn, body: JSON.stringify({ name: "Renamed", expectedRevision: 1 }) });
    expect(patched.status).toBe(200);
    const deleted = await routes.request(`/api/recipes/${RECIPE_ID}`, { method: "DELETE", headers: signedIn });
    expect(await deleted.json()).toEqual({ ok: true });
  });
});
