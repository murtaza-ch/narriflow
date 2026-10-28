import {
  brandCountRequirement,
  brandPlanRequirement,
  type BrandActorScope,
  type BrandFontService,
  type BrandPlanRequirement,
  type BrandProfileService,
  type BrandTemplateService,
  type SceneTemplateService,
} from "@narriflow/services";
import {
  planCountRequirement,
  planFeatureRequirement,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import type { BrandProfileSection } from "@narriflow/validators/api/brand";

/**
 * Screen aggregates of the Brand Kit. Each one does the reads its page used to
 * do with `Promise.all`, applies the page's own conditions (a role-gated read
 * stays role-gated), and returns the plan facts the services refuse with, so
 * the browser never recomputes policy or sees the 24-row ordinary page size.
 */

export interface BrandAggregateServices {
  profiles: Pick<
    BrandProfileService,
    "listAll" | "getDefaultId" | "get" | "usage" | "requireUsableId" | "resolveProfileForTemplate"
  >;
  templates: Pick<BrandTemplateService, "list" | "get">;
  fonts: Pick<BrandFontService, "list" | "resolveReferences">;
  scenes: Pick<SceneTemplateService, "list">;
}

type Requirement = BrandPlanRequirement | ReturnType<typeof planCountRequirement> | null;

/** Who may change what, as the pages gate it. */
export interface BrandAccess {
  /** `brand.manage` for the actor's role and Workspace status. */
  canManageBrand: boolean;
  /** Only the owner reaches billing from an upgrade prompt. */
  canManageBilling: boolean;
}

function accessOf(scope: BrandActorScope): BrandAccess {
  return {
    canManageBrand: workspaceAllowsCapability(
      { role: scope.role, status: scope.status },
      "brand.manage",
    ),
    canManageBilling: scope.role === "owner",
  };
}

/** Caption styles follow brand-template.service: the feature and its count, not the shared-Workspace branding rule. */
function styleCreateRequirement(scope: BrandActorScope, customStyleCount: number): Requirement {
  return (
    planCountRequirement(scope.pricingTier, "brandTemplates", customStyleCount) ??
    planFeatureRequirement(scope.pricingTier, "brand.customTemplates")
  );
}

export async function readBrandKit(services: BrandAggregateServices, scope: BrandActorScope) {
  const [profiles, defaultProfileId, templates, fonts] = await Promise.all([
    services.profiles.listAll(scope),
    services.profiles.getDefaultId(scope),
    services.templates.list(scope),
    services.fonts.list(scope),
  ]);
  // A Brand Profile plan gate, then its count: the tier to offer is never below the Workspace requirement.
  const profilesRequirement = brandPlanRequirement(scope, "brand.profiles");
  return {
    profiles,
    defaultProfileId,
    templates,
    fonts,
    access: accessOf(scope),
    plan: {
      /** Why Brand Profiles are unavailable on this plan, or null. */
      profiles: profilesRequirement,
      /** The count boundary for one more profile; null when profiles are unavailable or there is room. */
      profileCount: profilesRequirement
        ? null
        : brandCountRequirement(scope, "brand.profiles", "brandProfiles", profiles.length),
      customFonts: brandPlanRequirement(scope, "brand.customFonts"),
      /** Creating one more caption style. */
      styleCreate: styleCreateRequirement(scope, templates.mine.length),
      /** Using caption styles at all (the empty-state prompt). */
      customTemplates: planFeatureRequirement(scope.pricingTier, "brand.customTemplates"),
      governance: planFeatureRequirement(scope.pricingTier, "brand.governance"),
    },
  };
}

export async function readDefaultBrandProfile(
  services: BrandAggregateServices,
  scope: BrandActorScope,
  applicable: boolean,
) {
  // After a downgrade a remembered default means "no profile" for intake.
  const profileId = applicable
    ? brandPlanRequirement(scope, "brand.profiles")
      ? null
      : await services.profiles.getDefaultId(scope)
    : await services.profiles.getDefaultId(scope);
  return { profileId };
}

export async function readBrandProfileUsage(
  services: BrandAggregateServices,
  scope: BrandActorScope,
  profileId: string,
) {
  await services.profiles.requireUsableId(scope, profileId);
  const byProfile = await services.profiles.usage(scope, [profileId]);
  return byProfile[profileId] ?? { isDefault: false, recipes: [] };
}

export async function readBrandProfileDetail(
  services: BrandAggregateServices,
  scope: BrandActorScope,
  profileId: string,
  section: BrandProfileSection,
) {
  const profile = await services.profiles.get(scope, profileId);
  const access = accessOf(scope);
  // Attaching styles and audio and editing the fields are profile edits (same gate as the services); removing is role-only cleanup.
  const profilesRequirement = brandPlanRequirement(scope, "brand.profiles");
  const canAttach = access.canManageBrand && profilesRequirement === null;

  const [defaultProfileId, usage, others, sectionData] = await Promise.all([
    services.profiles.getDefaultId(scope),
    access.canManageBrand
      ? services.profiles.usage(scope, [profile.id])
      : Promise.resolve(null),
    canAttach ? services.profiles.listAll(scope) : Promise.resolve(null),
    readSection(services, scope, profile, section),
  ]);
  const isDefault = profile.id === defaultProfileId;
  return {
    profile,
    section,
    defaultProfileId,
    isDefault,
    access: { ...access, canAttach },
    plan: {
      profiles: profilesRequirement,
      customFonts: brandPlanRequirement(scope, "brand.customFonts"),
      governance: planFeatureRequirement(scope.pricingTier, "brand.governance"),
      scenes: brandPlanRequirement(scope, "brand.scenes"),
      defaultScenes: brandPlanRequirement(scope, "brand.defaultScenes"),
    },
    /** Present for a manager; what deleting this profile would affect. */
    usage: usage ? (usage[profile.id] ?? { isDefault, recipes: [] }) : null,
    /** Present when the actor can move defaults and Recipes elsewhere. */
    replacements: others
      ? others.filter((other) => other.id !== profile.id).map(({ id, name }) => ({ id, name }))
      : [],
    ...sectionData,
  };
}

type Profile = Awaited<ReturnType<BrandAggregateServices["profiles"]["get"]>>;

/** Only the active section's data is read, as the page did. */
async function readSection(
  services: BrandAggregateServices,
  scope: BrandActorScope,
  profile: Profile,
  section: BrandProfileSection,
) {
  if (section === "identity") return { fonts: await services.fonts.list(scope) };
  if (section === "scenes") return { scenes: await services.scenes.list(scope, profile.id) };
  if (section === "styles") {
    const [templates, profiles] = await Promise.all([
      services.templates.list(scope),
      services.profiles.listAll(scope),
    ]);
    // Styles belong to one profile at a time, so only unassigned ones can be added.
    const available = templates.mine
      .filter((template) => !profiles.some((other) => other.templates.some((style) => style.id === template.id)))
      .map(({ id, name }) => ({ id, name }));
    return {
      styles: {
        templates,
        available,
        createRequirement: styleCreateRequirement(scope, templates.mine.length),
      },
    };
  }
  return {};
}

export async function readBrandTemplateProfile(
  services: BrandAggregateServices,
  scope: BrandActorScope,
  templateId: string,
) {
  // The template must be visible to this Workspace before its profile is revealed.
  await services.templates.get(scope, templateId);
  return { profileId: await services.profiles.resolveProfileForTemplate(scope, templateId) };
}

export async function readBrandTemplateEditorAssets(
  services: BrandAggregateServices,
  scope: BrandActorScope,
  templateId: string,
) {
  const template = await services.templates.get(scope, templateId);
  const reference = template.captionPreset.fontAsset;
  const [activeFonts, retainedFonts] = await Promise.all([
    services.fonts.list(scope),
    services.fonts.resolveReferences(scope, reference ? [reference] : []),
  ]);
  // A font the style already uses stays resolvable after deletion, but cannot be picked for new text.
  const byId = new Map<string, (typeof activeFonts)[number] & { insertable: boolean }>();
  for (const font of retainedFonts) byId.set(font.id, { ...font, insertable: false });
  for (const font of activeFonts) byId.set(font.id, { ...font, insertable: true });
  return {
    fonts: [...byId.values()],
    access: accessOf(scope),
    plan: {
      customFonts: brandPlanRequirement(scope, "brand.customFonts"),
      customTemplates: planFeatureRequirement(scope.pricingTier, "brand.customTemplates"),
    },
  };
}
