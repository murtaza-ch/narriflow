import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { invalidateBillingDependents } from "./billing";
import { invalidateAfterClipChange } from "./clips/mutations";
import { scopedKey, sessionKey } from "./core/keys";
import { USER, WORKSPACE_A, WORKSPACE_B } from "./core/test-helpers";
import { invalidateAfterAutomationChange } from "./automation/invalidation";
import { invalidateBrand } from "./brand/queries";
import { invalidateAfterIntake } from "./ingest/invalidation";
import { clearProjectAccess, invalidateAfterProjectDeleted } from "./projects";
import {
  invalidateAfterAccountChange,
  invalidateAfterPostChange,
  invalidateAfterProposalChange,
  invalidatePublishing,
} from "./publishing";

const scope = { userId: USER, workspaceId: WORKSPACE_A };
const other = { userId: USER, workspaceId: WORKSPACE_B };
const PID = "p1";
const OTHER_PID = "p2";

/** Marks every key as freshly cached, so `isInvalidated` shows exactly what a helper touched. */
function cache(keys: Record<string, readonly unknown[]>) {
  const queryClient = new QueryClient();
  for (const key of Object.values(keys)) queryClient.setQueryData([...key], { fresh: true });
  const stale = (name: string) => queryClient.getQueryState([...(keys[name] as readonly unknown[])])?.isInvalidated === true;
  return { queryClient, stale };
}

const detail = (id: string) => [...scopedKey(scope, "projects", "detail", id), "overview"];

describe("billing change refreshes the plan-dependent aggregates (Sol B04)", () => {
  const keys = {
    billing: scopedKey(scope, "billing", "state"),
    bootstrap: scopedKey(scope, "workspace", "bootstrap"),
    identity: sessionKey({ userId: USER }, "bootstrap"),
    projectDetail: detail(PID),
    brandKit: scopedKey(scope, "brand", "profiles"),
    intakeConfiguration: scopedKey(scope, "ingest", "configuration"),
    studioAssets: scopedKey(scope, "studio", "editor-assets"),
    studioBootstrap: scopedKey(scope, "studio", "bootstrap", { projectId: PID, clipId: "c1" }),
    autopilot: scopedKey(scope, "automation", "overview"),
    otherWorkspace: scopedKey(other, "brand", "profiles"),
    unrelated: scopedKey(scope, "exports", "workspace-list"),
  };

  test("upgrade or downgrade invalidates them, never the Editing Session's document or another Workspace", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateBillingDependents(queryClient, scope);
    for (const name of ["billing", "bootstrap", "identity", "projectDetail", "brandKit", "intakeConfiguration", "studioAssets", "autopilot"]) {
      expect(stale(name)).toBe(true);
    }
    for (const name of ["studioBootstrap", "otherWorkspace", "unrelated"]) expect(stale(name)).toBe(false);
  });
});

describe("credit-changing commands refresh the usage the shell reads (Sol B05)", () => {
  const keys = {
    usage: scopedKey(scope, "workspace", "usage"),
    bootstrap: scopedKey(scope, "workspace", "bootstrap"),
    home: scopedKey(scope, "projects", "home"),
    explorer: scopedKey(scope, "projects", "explorer", {}),
    members: scopedKey(scope, "workspace", "members"),
  };

  test.each([
    ["accepted intake", (queryClient: QueryClient) => invalidateAfterIntake(queryClient, scope)],
    ["a clip render, regeneration or copy", (queryClient: QueryClient) => invalidateAfterClipChange(queryClient, scope, PID)],
    ["a deleted Project", (queryClient: QueryClient) => invalidateAfterProjectDeleted(queryClient, scope, PID)],
  ])("%s invalidates the bootstrap and the usage read", async (_name, run) => {
    const { queryClient, stale } = cache(keys);
    await run(queryClient);
    expect(stale("usage")).toBe(true);
    expect(stale("bootstrap")).toBe(true);
    expect(stale("members")).toBe(false);
  });

  test("a clip change also refreshes the home and explorer Project counts", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateAfterClipChange(queryClient, scope, PID);
    expect(stale("home")).toBe(true);
    expect(stale("explorer")).toBe(true);
  });
});

describe("publishing changes refresh the Project and account consumers (Sol B06)", () => {
  const keys = {
    queue: scopedKey(scope, "publishing", "queue"),
    thisProject: detail(PID),
    otherProject: detail(OTHER_PID),
    recipes: scopedKey(scope, "recipes", "list"),
    autopilot: scopedKey(scope, "automation", "overview"),
    brand: scopedKey(scope, "brand", "profiles"),
  };

  test("a post decision refreshes that Project's screen and nothing else of the Workspace", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateAfterPostChange(queryClient, scope, PID);
    expect(stale("queue")).toBe(true);
    expect(stale("thisProject")).toBe(true);
    for (const name of ["otherProject", "recipes", "autopilot", "brand"]) expect(stale(name)).toBe(false);
  });

  test("a proposal decision refreshes cached Project screens, where an accepted post is scheduled", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateAfterProposalChange(queryClient, scope);
    for (const name of ["queue", "thisProject", "otherProject"]) expect(stale(name)).toBe(true);
    expect(stale("recipes")).toBe(false);
  });

  test("an account change also refreshes the Recipe and Autopilot account choices", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateAfterAccountChange(queryClient, scope);
    for (const name of ["queue", "thisProject", "otherProject", "recipes", "autopilot"]) expect(stale(name)).toBe(true);
    expect(stale("brand")).toBe(false);
  });

  test("the bare publishing invalidator stays publishing-only", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidatePublishing(queryClient, scope);
    expect(stale("queue")).toBe(true);
    expect(stale("thisProject")).toBe(false);
  });
});

describe("lost Project access clears what the Project showed (Sol UI-2 R6)", () => {
  test("a mounted Project read drops its data and surfaces the refusal; other Projects and Workspaces are untouched", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let revoked = false;
    const keys = {
      detail: detail(PID),
      clips: scopedKey(scope, "clips", "list", PID),
      exportDetail: scopedKey(scope, "exports", "detail", { id: PID, clipId: "c1", exportId: "e1" }),
      otherProject: detail(OTHER_PID),
      otherWorkspace: [...scopedKey(other, "projects", "detail", PID), "overview"],
    };
    for (const [name, key] of Object.entries(keys)) queryClient.setQueryData([...key], { name, media: "https://cdn.example/signed" });
    const observer = new QueryObserver(queryClient, {
      queryKey: [...keys.detail],
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: async () => {
        if (revoked) throw new Error("project_not_found");
        return { name: "detail" };
      },
    });
    const stop = observer.subscribe(() => undefined);
    expect(observer.getCurrentResult().data).toBeDefined();

    revoked = true;
    await clearProjectAccess(queryClient, scope, PID);

    // The cached Project is gone and only the refusal remains; a plain invalidation would have kept the data beside the error.
    expect(observer.getCurrentResult()).toMatchObject({ data: undefined, isError: true });
    expect(queryClient.getQueryData([...keys.clips])).toBeUndefined();
    expect(queryClient.getQueryData([...keys.exportDetail])).toBeUndefined();
    expect(queryClient.getQueryData([...keys.otherProject])).toBeDefined();
    expect(queryClient.getQueryData([...keys.otherWorkspace])).toBeDefined();
    stop();
  });
});

describe("dependent aggregates follow their sources (Sol UI-2 R9)", () => {
  const keys = {
    integrations: scopedKey(scope, "developer", "overview"),
    grants: scopedKey(scope, "automation", "standing-grants"),
    recipes: scopedKey(scope, "recipes", "list"),
    zoom: scopedKey(scope, "automation", "zoom-connections"),
    otherWorkspaceGrants: scopedKey(other, "automation", "standing-grants"),
  };

  test("connecting or disconnecting an account refreshes Integrations and Standing Grants", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateAfterAccountChange(queryClient, scope);
    for (const name of ["integrations", "grants", "recipes"]) expect(stale(name)).toBe(true);
    expect(stale("otherWorkspaceGrants")).toBe(false);
  });

  test("a Brand Profile change refreshes Standing Grants, which pause when their Recipe changes", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateBrand(queryClient, scope);
    expect(stale("grants")).toBe(true);
    expect(stale("otherWorkspaceGrants")).toBe(false);
  });

  test("an automation change refreshes the Recipes that show their rule use", async () => {
    const { queryClient, stale } = cache(keys);
    await invalidateAfterAutomationChange(queryClient, scope);
    for (const name of ["grants", "zoom", "recipes"]) expect(stale(name)).toBe(true);
    expect(stale("otherWorkspaceGrants")).toBe(false);
  });
});
