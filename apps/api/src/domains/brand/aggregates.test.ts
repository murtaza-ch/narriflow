import { describe, expect, mock, test } from "bun:test";
import type { BrandActorScope } from "@narriflow/services";
import {
  type BrandAggregateServices,
  readBrandKit,
  readBrandProfileDetail,
  readBrandProfileUsage,
  readBrandTemplateEditorAssets,
  readBrandTemplateProfile,
  readDefaultBrandProfile,
} from "./aggregates";

const scope = (overrides: Partial<BrandActorScope> = {}): BrandActorScope => ({
  actorUserId: "user",
  workspaceId: "workspace",
  workspaceOwnerUserId: "owner",
  role: "owner",
  status: "active",
  pricingTier: "business",
  isPersonalWorkspace: false,
  ...overrides,
});

const style = (id: string, name: string) => ({ id, name, captionPreset: { fontAsset: null } });

function services() {
  const profile = (id: string, styles: string[] = []) => ({
    id,
    name: `Profile ${id}`,
    templates: styles.map((styleId) => ({ id: styleId })),
  });
  const stubs = {
    profiles: {
      listAll: mock(async () => [profile("p1", ["s1"]), profile("p2")]),
      getDefaultId: mock(async () => "p1"),
      get: mock(async (_scope: unknown, id: string) => profile(id, ["s1"])),
      usage: mock(async () => ({ p1: { isDefault: true, recipes: [{ id: "r", name: "Weekly" }] } })),
      requireUsableId: mock(async (_scope: unknown, id: string) => id),
      resolveProfileForTemplate: mock(async () => "p1"),
    },
    templates: {
      list: mock(async () => ({
        builtIns: [style("b1", "Built in")],
        mine: [style("s1", "Assigned"), style("s2", "Free")],
        defaultId: null,
      })),
      get: mock(async (_scope: unknown, id: string) => ({
        id,
        name: "Style",
        captionPreset: { fontAsset: { id: "f-retained", fingerprint: "x" } },
      })),
    },
    fonts: {
      list: mock(async () => [{ id: "f-active", family: "Inter" }]),
      resolveReferences: mock(async () => [{ id: "f-retained", family: "Gone" }, { id: "f-active", family: "Inter" }]),
    },
    scenes: { list: mock(async () => [{ id: "scene" }]) },
  };
  return { stubs, deps: stubs as unknown as BrandAggregateServices };
}

describe("brand kit aggregate", () => {
  test("reads every profile rather than the ordinary page, with the page's plan facts", async () => {
    const { stubs, deps } = services();
    const kit = await readBrandKit(deps, scope());
    expect(stubs.profiles.listAll).toHaveBeenCalledTimes(1);
    expect(kit.profiles).toHaveLength(2);
    expect(kit.defaultProfileId).toBe("p1");
    expect(kit.templates.mine).toHaveLength(2);
    expect(kit.access).toEqual({ canManageBrand: true, canManageBilling: true });
    expect(kit.plan.profiles).toBeNull();
    expect(kit.plan.customFonts).toBeNull();
  });

  test("a plan without profiles reports the requirement and no count boundary", async () => {
    const { deps } = services();
    const kit = await readBrandKit(deps, scope({ pricingTier: "free", isPersonalWorkspace: true }));
    expect(kit.plan.profiles).toMatchObject({ requiredTier: expect.any(String) });
    expect(kit.plan.profileCount).toBeNull();
  });

  test("a viewer is read-only and is not offered billing", async () => {
    const { deps } = services();
    const kit = await readBrandKit(deps, scope({ role: "viewer" }));
    expect(kit.access).toEqual({ canManageBrand: false, canManageBilling: false });
  });
});

describe("default profile", () => {
  test("the applicable default is none after the plan no longer includes profiles", async () => {
    const { stubs, deps } = services();
    const downgraded = scope({ pricingTier: "free", isPersonalWorkspace: true });
    expect(await readDefaultBrandProfile(deps, downgraded, true)).toEqual({ profileId: null });
    expect(stubs.profiles.getDefaultId).not.toHaveBeenCalled();
    expect(await readDefaultBrandProfile(deps, downgraded, false)).toEqual({ profileId: "p1" });
  });
});

describe("profile usage", () => {
  test("an unused profile has an empty usage rather than none", async () => {
    const { deps } = services();
    expect(await readBrandProfileUsage(deps, scope(), "p2")).toEqual({ isDefault: false, recipes: [] });
    expect((await readBrandProfileUsage(deps, scope(), "p1")).recipes).toHaveLength(1);
  });

  test("a profile of another Workspace is refused before usage is read", async () => {
    const { stubs, deps } = services();
    stubs.profiles.requireUsableId.mockImplementation(async () => {
      throw new Error("brand_profile_not_found");
    });
    await expect(readBrandProfileUsage(deps, scope(), "foreign")).rejects.toThrow("brand_profile_not_found");
    expect(stubs.profiles.usage).not.toHaveBeenCalled();
  });
});

describe("profile detail aggregate", () => {
  test("a manager gets usage and replacement choices without the profile itself", async () => {
    const { deps } = services();
    const detail = await readBrandProfileDetail(deps, scope(), "p1", "identity");
    expect(detail.usage).toMatchObject({ isDefault: true });
    expect(detail.replacements).toEqual([{ id: "p2", name: "Profile p2" }]);
    expect(detail.access).toEqual({ canManageBrand: true, canManageBilling: true, canAttach: true });
    expect(detail).toHaveProperty("fonts");
  });

  test("a viewer's role-gated reads are not made", async () => {
    const { stubs, deps } = services();
    const detail = await readBrandProfileDetail(deps, scope({ role: "viewer" }), "p1", "identity");
    expect(detail.usage).toBeNull();
    expect(detail.replacements).toEqual([]);
    expect(stubs.profiles.usage).not.toHaveBeenCalled();
  });

  test("replacements need a plan that includes profiles", async () => {
    const { stubs, deps } = services();
    const detail = await readBrandProfileDetail(
      deps,
      scope({ pricingTier: "free", isPersonalWorkspace: true }),
      "p1",
      "identity",
    );
    expect(detail.replacements).toEqual([]);
    expect(stubs.profiles.listAll).not.toHaveBeenCalled();
    expect(detail.access.canAttach).toBe(false);
  });

  test("only the active section's data is read", async () => {
    const { stubs, deps } = services();
    const scenes = await readBrandProfileDetail(deps, scope(), "p1", "scenes");
    expect(scenes).toHaveProperty("scenes");
    expect(scenes).not.toHaveProperty("fonts");
    expect(stubs.fonts.list).not.toHaveBeenCalled();
    const voice = await readBrandProfileDetail(deps, scope(), "p1", "voice");
    expect(voice).not.toHaveProperty("scenes");
    expect(voice).not.toHaveProperty("styles");
  });

  test("styles offer only the ones no profile holds, and the create boundary", async () => {
    const { deps } = services();
    const detail = await readBrandProfileDetail(deps, scope(), "p2", "styles");
    // s1 belongs to p1; s2 is free.
    expect(detail.styles?.available).toEqual([{ id: "s2", name: "Free" }]);
    expect(detail.styles?.createRequirement).toBeNull();
  });
});

describe("caption style reads", () => {
  test("the profile of a style is revealed only for a style this Workspace can see", async () => {
    const { stubs, deps } = services();
    expect(await readBrandTemplateProfile(deps, scope(), "s1")).toEqual({ profileId: "p1" });
    stubs.templates.get.mockImplementation(async () => {
      throw new Error("brand_template_not_found");
    });
    await expect(readBrandTemplateProfile(deps, scope(), "foreign")).rejects.toThrow("brand_template_not_found");
    expect(stubs.profiles.resolveProfileForTemplate).toHaveBeenCalledTimes(1);
  });

  test("a retained font stays resolvable but is not offered for new text", async () => {
    const { deps } = services();
    const assets = await readBrandTemplateEditorAssets(deps, scope(), "s1");
    const byId = Object.fromEntries(assets.fonts.map((font) => [font.id, font.insertable]));
    expect(byId).toEqual({ "f-retained": false, "f-active": true });
    expect(assets.plan.customTemplates).toBeNull();
  });
});
