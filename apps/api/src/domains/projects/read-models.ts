import { toFolderView } from "../library/folders";
import type { BrowserActorScope } from "../../http/request-policy-runtime";
import {
  hasFeature,
  lowestTierWithFeature,
  planLimits,
  resolvePricingTier,
  workspaceAllowsCapability,
} from "@narriflow/validators";
import type { ProjectListQuery, ProjectTab } from "@narriflow/validators/api/projects";
import type {
  analyticsService,
  autopilotService,
  brandProfileService,
  clipService,
  dubbingService,
  getProcessingUsage,
  getProjectFinishing,
  presignDownloadUrl,
  projectService,
  reviewService,
  socialOAuthService,
  socialService,
  workspaceLibraryService,
  workspaceService,
} from "@narriflow/services";

/** The services the screen aggregates call. They stay authoritative; this module only fans out and projects. */
export interface ProjectReadDeps {
  projectService: Pick<
    typeof projectService,
    | "getProjectSnapshot"
    | "getTranscriptSnapshot"
    | "getTranscriptStatusSnapshot"
    | "getLatestContentPack"
    | "getWorkflowHistory"
    | "getUsageSummary"
  >;
  workspaceLibraryService: Pick<typeof workspaceLibraryService, "listProjects" | "listFolders">;
  clipService: Pick<typeof clipService, "listClips">;
  socialService: Pick<typeof socialService, "listProjectPosts">;
  socialOAuthService: Pick<typeof socialOAuthService, "listAccounts">;
  analyticsService: Pick<typeof analyticsService, "getProjectAnalytics">;
  dubbingService: Pick<typeof dubbingService, "listProjectDubs" | "getDubbingAllowance">;
  brandProfileService: Pick<typeof brandProfileService, "list">;
  reviewService: Pick<typeof reviewService, "internalRoom">;
  workspaceService: Pick<typeof workspaceService, "getWorkspace">;
  autopilotService: Pick<typeof autopilotService, "listRules">;
  getProjectFinishing: typeof getProjectFinishing;
  getProcessingUsage: () => Pick<ReturnType<typeof getProcessingUsage>, "projectCreditUsage">;
  presignDownloadUrl: typeof presignDownloadUrl;
}

const RECENT_PROJECTS_LIMIT = 8;
/** Long enough for the Trim/Extend dialog to keep playing; the client refetches after `expiresAt`. */
export const SOURCE_URL_TTL_SECONDS = 3600;
/** The Brand Profile picker lists every profile the actor can use, not one 24-row page. */
const BRAND_PICKER_LIMIT = 100;

function brandScopeOf(actor: BrowserActorScope) {
  return {
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  };
}

function showsRetentionBanner(pricingTier: string): boolean {
  return planLimits(resolvePricingTier(pricingTier)).projectRetentionHours !== null;
}

/** `GET /api/home`: recent Projects plus the facts the dashboard's cards depend on. */
export async function readHome(deps: ProjectReadDeps, actor: BrowserActorScope) {
  const canCreate = workspaceAllowsCapability(actor.workspace, "content.edit");
  const [recent, rules] = await Promise.all([
    deps.workspaceLibraryService.listProjects(actor, { limit: RECENT_PROJECTS_LIMIT }),
    // Only editors see the Autopilot card.
    canCreate ? deps.autopilotService.listRules(actor) : Promise.resolve([]),
  ]);
  return {
    firstName: actor.firstName?.trim() || null,
    items: recent.items,
    canCreate,
    readOnlyReason: (actor.workspace.role === "viewer"
      ? "viewer"
      : actor.workspace.status === "active"
        ? null
        : "paused") as "viewer" | "paused" | null,
    canManageBilling: actor.workspace.role === "owner",
    autopilot: {
      lockedTier: hasFeature(actor.pricingTier, "automation.autopilot")
        ? null
        : lowestTierWithFeature("automation.autopilot"),
      rules: rules.length,
      activeRules: rules.filter((rule) => rule.status === "active" || rule.status === "running").length,
    },
    showRetentionBanner: showsRetentionBanner(actor.workspace.pricingTier),
  };
}

/** `GET /api/projects/explorer`: the filtered page, the folders and the facts the page chrome needs, in one read. */
export async function readExplorer(deps: ProjectReadDeps, actor: BrowserActorScope, query: ProjectListQuery) {
  const [page, folders] = await Promise.all([
    deps.workspaceLibraryService.listProjects(actor, {
      folderId: query.folder,
      query: query.q,
      status: query.status,
      source: query.source,
      sort: query.sort,
      limit: query.limit,
      cursor: query.cursor,
    }),
    deps.workspaceLibraryService.listFolders(actor),
  ]);
  const folderViews = folders.map(toFolderView);
  const activeFolder = query.folder ? folderViews.find((folder) => folder.id === query.folder) : undefined;
  return {
    page,
    folders: folderViews,
    activeFolder: activeFolder ? { id: activeFolder.id, name: activeFolder.name } : null,
    filters: {
      q: query.q,
      status: query.status,
      source: query.source,
      sort: query.sort,
      folder: query.folder ?? null,
    },
    access: {
      // Mirrors the folder, move and delete controls' own `content.edit` check.
      canEdit: workspaceAllowsCapability(actor.workspace, "content.edit"),
      canCreate: workspaceAllowsCapability(actor.workspace, "processing.consume"),
      canManageBilling: actor.workspace.role === "owner",
      showRetentionBanner: showsRetentionBanner(actor.workspace.pricingTier),
    },
  };
}

/** A short-lived grant for the Project's source video, or null once the source was reclaimed. */
export async function readSourceGrant(deps: Pick<ProjectReadDeps, "presignDownloadUrl">, sourceStorageKey: string | null) {
  if (!sourceStorageKey) return null;
  try {
    const url = await deps.presignDownloadUrl({ key: sourceStorageKey, expiresIn: SOURCE_URL_TTL_SECONDS });
    return { url, expiresAt: new Date(Date.now() + SOURCE_URL_TTL_SECONDS * 1000).toISOString() };
  } catch {
    // Non-fatal: the preview degrades to transcript-only.
    return null;
  }
}

/** The Brand Profile summaries the Project's picker draws, without the full aggregates. */
async function readBrandChoices(deps: ProjectReadDeps, actor: BrowserActorScope) {
  const profiles = await deps.brandProfileService.list(brandScopeOf(actor), { limit: BRAND_PICKER_LIMIT, includeDeleted: false });
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    colors: profile.identity,
    logoUrl:
      profile.assets.find(
        (asset) => asset.id === profile.identity.primaryLogoAssetId || asset.role === "logo",
      )?.accessUrl ?? null,
  }));
}

/**
 * `GET /api/projects/:id/detail?tab=`: what the Project screen needs on every
 * tab, plus the active tab's own data. Every read starts together, so the
 * browser makes one request, and a tab's data is read only when that tab is open
 * (the full transcript only on the transcript tab). Returns null when the
 * Project vanished between admission and the read.
 */
export async function readProjectDetail(
  deps: ProjectReadDeps,
  actor: BrowserActorScope,
  projectId: string,
  tab: ProjectTab,
) {
  const canManageReview = workspaceAllowsCapability({ role: actor.role, status: actor.status }, "review.manage");
  const onTranscript = tab === "transcript";
  const needsAccounts = tab === "posts" || tab === "clips";
  const snapshotRead = deps.projectService.getProjectSnapshot(actor, projectId);

  const [
    snapshot,
    transcript,
    clips,
    contentPack,
    socialPosts,
    workflowHistory,
    usage,
    finishing,
    creditUsage,
    analytics,
    socialAccounts,
    workspace,
    dubs,
    dubAllowance,
    brandChoices,
    reviewRoom,
    sourceVideo,
  ] = await Promise.all([
    snapshotRead,
    onTranscript
      ? deps.projectService.getTranscriptSnapshot(actor, projectId)
      : deps.projectService.getTranscriptStatusSnapshot(actor, projectId),
    deps.clipService.listClips(actor, projectId),
    deps.projectService.getLatestContentPack(actor, projectId),
    deps.socialService.listProjectPosts(actor, projectId),
    deps.projectService.getWorkflowHistory(actor, projectId),
    deps.projectService.getUsageSummary(actor),
    deps.getProjectFinishing({ workspaceId: actor.workspaceId, projectId }),
    // The period settlement checks, excluding this Project's own reservation.
    deps.getProcessingUsage().projectCreditUsage(projectId),
    tab === "analytics" ? deps.analyticsService.getProjectAnalytics(actor, projectId) : Promise.resolve(null),
    needsAccounts ? deps.socialOAuthService.listAccounts(actor) : Promise.resolve([]),
    needsAccounts ? deps.workspaceService.getWorkspace(actor.actorUserId, actor.workspaceId) : Promise.resolve(null),
    tab === "dubbing" ? deps.dubbingService.listProjectDubs(actor, projectId) : Promise.resolve([]),
    tab === "dubbing" ? deps.dubbingService.getDubbingAllowance(actor) : Promise.resolve(null),
    tab === "clips" ? readBrandChoices(deps, actor) : Promise.resolve([]),
    tab === "review"
      ? deps.reviewService.internalRoom(actor.workspaceId, projectId, canManageReview ? "manage" : "view")
      : Promise.resolve(null),
    tab === "clips"
      ? snapshotRead.then((read) => readSourceGrant(deps, read.project?.sourceStorageKey ?? null))
      : Promise.resolve(null),
  ]);

  if (!snapshot.project) return null;
  return {
    tab,
    access: {
      role: actor.role,
      status: actor.status,
      pricingTier: usage.tier,
      isPersonalWorkspace: actor.isPersonalWorkspace,
    },
    snapshot,
    transcript: { view: onTranscript ? ("full" as const) : ("status" as const), data: transcript },
    clips,
    contentPack,
    socialPosts,
    workflowHistory,
    usage,
    finishing,
    creditUsage,
    tabData: {
      analytics,
      socialAccounts,
      workspaceTimezone: workspace?.timezone ?? null,
      dubs,
      dubAllowance,
      brandChoices,
      reviewRoom,
      sourceVideo,
    },
  };
}
