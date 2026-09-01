import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  brandProfileCreateSchema,
  brandProfileMembershipSchema,
  brandProfileSoftDeleteSchema,
  brandProfileUpdateSchema,
  reusableAssetSoftDeleteSchema,
  visualAssetFinalizeSchema,
  visualAssetUploadSchema,
  sceneTemplateCreateSchema,
  sceneTemplateDeleteSchema,
  sceneTemplateUpdateSchema,
  applySceneTemplateSchema,
  createReviewRoundSchema,
  createExportBundleSchema,
  type WorkspaceCapability,
} from "@narriflow/validators";
import { z, type ZodType } from "zod";
import type { AuthenticatedRequestAdmission } from "./authenticated-request-policy";

interface HonoSurface {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  capability: WorkspaceCapability;
  projectParam?: "id" | "projectId";
  rateLimit?: {
    scope: "actor" | "workspace";
    prefix: string;
    limit: number;
    windowSeconds: number;
  };
  input?: {
    schema: ZodType;
    body?: "required" | "optional";
    params?: readonly string[];
    query?: readonly string[];
  };
}

const uuidInput = z.string().uuid();
const bodyInput = (schema: ZodType, params: readonly string[] = []) => ({
  schema: z.object({
    ...Object.fromEntries(params.map((name) => [name, uuidInput])),
    body: schema,
  }).strict(),
  body: "required" as const,
  params,
});
const optionalBodyInput = (schema: ZodType, params: readonly string[]) => ({
  schema: z.object({
    ...Object.fromEntries(params.map((name) => [name, uuidInput])),
    body: schema,
  }).strict(),
  body: "optional" as const,
  params,
});
const paramsInput = (...params: string[]) => ({
  schema: z.object(
    Object.fromEntries(params.map((name) => [name, uuidInput])),
  ).strict(),
  params,
});

const project = (
  method: HonoSurface["method"],
  path: string,
  capability: WorkspaceCapability,
  rateLimit?: HonoSurface["rateLimit"],
): HonoSurface => ({ method, path, capability, projectParam: "id", rateLimit });

const actorRate = (
  prefix: string,
  limit: number,
  windowSeconds = 60,
): NonNullable<HonoSurface["rateLimit"]> => ({
  scope: "actor",
  prefix,
  limit,
  windowSeconds,
});

const workspaceRate = (
  prefix: string,
  limit: number,
  windowSeconds = 60,
): NonNullable<HonoSurface["rateLimit"]> => ({
  scope: "workspace",
  prefix,
  limit,
  windowSeconds,
});

export const browserSessionHonoSurfaces: readonly HonoSurface[] = [
  { method: "GET", path: "/autopilot/rules", capability: "content.view" },
  {
    method: "POST",
    path: "/autopilot/rules",
    capability: "content.edit",
    rateLimit: workspaceRate("autopilot-create", 5, 3_600),
  },
  {
    method: "PATCH",
    path: "/autopilot/rules/:ruleId",
    capability: "content.edit",
  },
  {
    method: "DELETE",
    path: "/autopilot/rules/:ruleId",
    capability: "content.edit",
  },
  {
    method: "POST",
    path: "/autopilot/rules/:ruleId/run-now",
    capability: "processing.consume",
    rateLimit: workspaceRate("autopilot-run", 10, 3_600),
  },
  { method: "GET", path: "/projects", capability: "content.view" },
  { method: "GET", path: "/workspace/search", capability: "content.view" },
  {
    method: "GET",
    path: "/workspace/exports/:exportId/download",
    capability: "content.download",
  },
  {
    method: "POST",
    path: "/workspace/avatar/presign",
    capability: "workspace.manage",
  },
  {
    method: "PATCH",
    path: "/workspace/avatar",
    capability: "workspace.manage",
  },
  project(
    "POST",
    "/projects/:id/generate",
    "processing.consume",
    actorRate("gen", 20),
  ),
  project("GET", "/projects/:id", "content.view"),
  project("GET", "/projects/:id/runs/:workflowRunId", "content.view"),
  project("GET", "/projects/:id/transcript", "content.view"),
  project("GET", "/projects/:id/transcript/utterances", "content.view"),
  project("GET", "/projects/:id/transcript/export", "content.download"),
  { method: "POST", path: "/ingest/link", capability: "processing.consume" },
  {
    method: "POST",
    path: "/ingest/rss/preview",
    capability: "processing.consume",
    rateLimit: workspaceRate("rss-preview", 20),
  },
  {
    method: "POST",
    path: "/ingest/rss/import",
    capability: "processing.consume",
    rateLimit: workspaceRate("rss-import", 5),
  },
  {
    method: "GET",
    path: "/ingest/:projectId",
    capability: "content.view",
    projectParam: "projectId",
  },
  project("GET", "/projects/:id/clips", "content.view"),
  project("GET", "/projects/:id/clips/:clipId/preview-peaks", "content.view"),
  project("PATCH", "/projects/:id/clips/:clipId", "content.edit"),
  project(
    "POST",
    "/projects/:id/clips/:clipId/title-suggestions",
    "processing.consume",
    actorRate("clip-title-suggest", 30),
  ),
  project(
    "POST",
    "/projects/:id/clips/:clipId/duplicate",
    "content.edit",
    actorRate("clip-duplicate", 30),
  ),
  project(
    "POST",
    "/projects/:id/clips/:clipId/create-from-selection",
    "content.edit",
  ),
  project("GET", "/projects/:id/clips/:clipId/editor", "content.edit"),
  project("PUT", "/projects/:id/clips/:clipId/editor", "content.edit"),
  project("POST", "/projects/:id/clips/:clipId/editor/reset", "content.edit"),
  project("DELETE", "/projects/:id/clips/:clipId", "content.edit"),
  project(
    "POST",
    "/projects/:id/clips/regenerate",
    "processing.consume",
    actorRate("regenerate", 20),
  ),
  project(
    "POST",
    "/projects/:id/clips/render",
    "processing.consume",
    actorRate("render", 20),
  ),
  project(
    "POST",
    "/projects/:id/clips/:clipId/exports",
    "processing.consume",
    actorRate("clip-export", 20),
  ),
  { method: "POST", path: "/projects/:id/export-bundles", capability: "content.download", projectParam: "id", rateLimit: actorRate("export-bundle", 10, 3_600), input: bodyInput(createExportBundleSchema, ["id"]) },
  { method: "GET", path: "/projects/:id/export-bundles", capability: "content.view", projectParam: "id" },
  { method: "GET", path: "/projects/:id/campaign-operations", capability: "content.view", projectParam: "id" },
  { method: "GET", path: "/projects/:id/export-bundles/:bundleId", capability: "content.view", projectParam: "id", input: paramsInput("id", "bundleId") },
  { method: "GET", path: "/projects/:id/export-bundles/:bundleId/download", capability: "content.download", projectParam: "id", input: paramsInput("id", "bundleId") },
  { method: "POST", path: "/projects/:id/export-bundles/:bundleId/retry", capability: "content.download", projectParam: "id", rateLimit: actorRate("export-bundle-retry", 10, 3_600), input: paramsInput("id", "bundleId") },
	{ method: "POST", path: "/projects/:id/campaign-operations/:operationId/retry-export-bundle", capability: "content.download", projectParam: "id", rateLimit: actorRate("export-operation-retry", 10, 3_600), input: paramsInput("id", "operationId") },
  { method: "POST", path: "/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply", capability: "content.edit", projectParam: "id", rateLimit: actorRate("apply-scene-template", 20, 3_600), input: bodyInput(applySceneTemplateSchema, ["id", "profileId", "templateId"]) },
  { method: "POST", path: "/projects/:id/review-rounds", capability: "review.manage", projectParam: "id", rateLimit: actorRate("review-round", 20, 3_600), input: bodyInput(createReviewRoundSchema, ["id"]) },
  { method: "POST", path: "/projects/:id/review-rounds/:roundId/revoke", capability: "review.manage", projectParam: "id", input: paramsInput("id", "roundId") },
  project(
    "GET",
    "/projects/:id/clips/:clipId/exports/:exportId",
    "content.download",
  ),
  project(
    "POST",
    "/projects/:id/clips/:clipId/exports/:exportId/retry",
    "processing.consume",
    actorRate("clip-export-retry", 12),
  ),
  project(
    "POST",
    "/projects/:id/clips/:clipId/exports/:exportId/share-links",
    "content.edit",
    actorRate("clip-share", 10),
  ),
  project(
    "DELETE",
    "/projects/:id/clips/:clipId/exports/:exportId/share-links",
    "content.edit",
  ),
  project("POST", "/projects/:id/clips/apply-caption-preset", "content.edit"),
  project("POST", "/projects/:id/clips/apply-studio-edits", "content.edit"),
  {
    method: "GET",
    path: "/broll/search",
    capability: "content.edit",
    rateLimit: actorRate("broll-search", 60),
  },
  project("GET", "/projects/:id/content-suite", "content.view"),
  project(
    "POST",
    "/projects/:id/content-suite",
    "processing.consume",
    actorRate("content-suite", 30),
  ),
  project("GET", "/projects/:id/analytics", "content.view"),
  { method: "GET", path: "/social/accounts", capability: "social.manage" },
  {
    method: "GET",
    path: "/social/oauth/start/:platform",
    capability: "social.manage",
  },
  { method: "GET", path: "/social/oauth/facebook-selection/:token", capability: "social.manage" },
  { method: "POST", path: "/social/oauth/facebook-selection/:token", capability: "social.manage", rateLimit: actorRate("facebook-page-selection", 10, 900) },
  {
    method: "DELETE",
    path: "/social/accounts/:accountId",
    capability: "social.manage",
  },
  project("GET", "/projects/:id/social-posts", "content.view"),
  project(
    "POST",
    "/projects/:id/social-posts",
    "publishing.manage",
    actorRate("social-posts", 30),
  ),
  project("DELETE", "/projects/:id/social-posts/:postId", "publishing.manage"),
  project(
    "GET",
    "/projects/:id/social-posts/:postId/publication",
    "content.view",
  ),
  project(
    "POST",
    "/projects/:id/social-posts/:postId/recheck",
    "publishing.manage",
  ),
  project(
    "POST",
    "/projects/:id/social-posts/:postId/confirm",
    "publishing.manage",
  ),
  project(
    "POST",
    "/projects/:id/social-posts/:postId/publish-again",
    "publishing.manage",
  ),
  project(
    "POST",
    "/projects/:id/social-posts/:postId/metrics",
    "publishing.manage",
  ),
  project("GET", "/projects/:id/dubs", "content.view"),
  project(
    "POST",
    "/projects/:id/dubs",
    "processing.consume",
    actorRate("dubs", 20),
  ),
  project("GET", "/projects/:id/dubs/:dubId/download", "content.download"),
  project("GET", "/projects/:id/clips/previews", "content.view"),
  project("GET", "/projects/:id/clips/:clipId/download", "content.download"),
  project("GET", "/projects/:id/clips/:clipId/file", "content.download"),
  { method: "GET", path: "/brand-templates", capability: "content.view" },
  { method: "GET", path: "/brand-templates/:id", capability: "content.view" },
  { method: "POST", path: "/brand-templates", capability: "brand.manage" },
  { method: "PATCH", path: "/brand-templates/:id", capability: "brand.manage" },
  {
    method: "DELETE",
    path: "/brand-templates/:id",
    capability: "brand.manage",
  },
  {
    method: "POST",
    path: "/brand-templates/:id/set-default",
    capability: "workspace.manage",
  },
  {
    method: "POST",
    path: "/brand-templates/:id/duplicate",
    capability: "brand.manage",
  },
  {
    method: "POST",
    path: "/brand-templates/logo/presign",
    capability: "brand.manage",
    rateLimit: actorRate("logo-presign", 30),
  },
  {
    method: "GET",
    path: "/brand-templates/:id/logo-url",
    capability: "content.view",
  },
  {
    method: "GET",
    path: "/brand-profiles",
    capability: "content.view",
    input: {
      schema: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        query: z.string().trim().max(100).optional(),
      }).strict(),
      query: ["limit", "query"],
    },
  },
  { method: "GET", path: "/brand-profiles/:id", capability: "content.view", input: paramsInput("id") },
  { method: "POST", path: "/brand-profiles", capability: "brand.manage", input: bodyInput(brandProfileCreateSchema) },
  { method: "PATCH", path: "/brand-profiles/:id", capability: "brand.manage", input: bodyInput(brandProfileUpdateSchema, ["id"]) },
  { method: "PUT", path: "/brand-profiles/:id/membership", capability: "brand.manage", input: bodyInput(brandProfileMembershipSchema, ["id"]) },
  { method: "POST", path: "/brand-profiles/:id/set-default", capability: "brand.manage", input: paramsInput("id") },
  { method: "DELETE", path: "/brand-profiles/:id", capability: "brand.manage", input: bodyInput(brandProfileSoftDeleteSchema, ["id"]) },
  { method: "GET", path: "/brand-profiles/:id/scene-templates", capability: "content.view", input: paramsInput("id") },
  { method: "POST", path: "/brand-profiles/:id/scene-templates", capability: "brand.manage", input: bodyInput(sceneTemplateCreateSchema, ["id"]) },
  { method: "PATCH", path: "/brand-profiles/:id/scene-templates/:templateId", capability: "brand.manage", input: bodyInput(sceneTemplateUpdateSchema, ["id", "templateId"]) },
  { method: "DELETE", path: "/brand-profiles/:id/scene-templates/:templateId", capability: "brand.manage", input: bodyInput(sceneTemplateDeleteSchema, ["id", "templateId"]) },
  { method: "GET", path: "/visual-assets", capability: "content.view" },
  {
    method: "POST",
    path: "/visual-assets/presign-upload",
    capability: "brand.manage",
    rateLimit: actorRate("visual-asset-presign", 30),
    input: bodyInput(visualAssetUploadSchema),
  },
  { method: "POST", path: "/visual-assets", capability: "brand.manage", input: bodyInput(visualAssetFinalizeSchema) },
  { method: "DELETE", path: "/visual-assets/:id", capability: "brand.manage", input: optionalBodyInput(reusableAssetSoftDeleteSchema, ["id"]) },
  { method: "GET", path: "/brand-fonts", capability: "content.view" },
  {
    method: "POST",
    path: "/brand-fonts/presign-upload",
    capability: "brand.manage",
    rateLimit: actorRate("brand-font-presign", 30),
    input: bodyInput(brandFontUploadSchema),
  },
  { method: "POST", path: "/brand-fonts", capability: "brand.manage", input: bodyInput(brandFontFinalizeSchema) },
  { method: "DELETE", path: "/brand-fonts/:id", capability: "brand.manage", input: optionalBodyInput(reusableAssetSoftDeleteSchema, ["id"]) },
  { method: "GET", path: "/audio-assets", capability: "content.view" },
  {
    method: "POST",
    path: "/audio-assets/presign-upload",
    capability: "brand.manage",
    rateLimit: actorRate("audio-asset-presign", 30),
  },
  { method: "POST", path: "/audio-assets", capability: "brand.manage" },
  {
    method: "GET",
    path: "/audio-assets/:id/playback-url",
    capability: "content.view",
  },
  {
    method: "PUT",
    path: "/audio-assets/:id/favorite",
    capability: "brand.manage",
  },
  {
    method: "DELETE",
    path: "/audio-assets/:id/favorite",
    capability: "brand.manage",
  },
  { method: "DELETE", path: "/audio-assets/:id", capability: "brand.manage" },
  {
    method: "POST",
    path: "/upload-sessions/open",
    capability: "processing.consume",
    rateLimit: actorRate("upload-session-open", 60),
  },
  {
    method: "POST",
    path: "/upload-sessions/finalize",
    capability: "processing.consume",
    rateLimit: actorRate("upload-session-finalize", 60),
  },
  {
    method: "POST",
    path: "/upload-sessions/grants",
    capability: "processing.consume",
    rateLimit: actorRate("upload-session-grants", 120),
  },
  {
    method: "POST",
    path: "/upload-sessions/status",
    capability: "processing.consume",
    rateLimit: actorRate("upload-session-status", 120),
  },
  {
    method: "POST",
    path: "/upload-sessions/discard",
    capability: "processing.consume",
    rateLimit: actorRate("upload-session-discard", 30),
  },
  { method: "POST", path: "/billing/checkout", capability: "billing.manage" },
  {
    method: "POST",
    path: "/billing/checkout/return",
    capability: "billing.manage",
  },
  { method: "POST", path: "/billing/portal", capability: "billing.manage" },
  { method: "GET", path: "/billing/state", capability: "content.view" },
  { method: "POST", path: "/billing/reconcile", capability: "billing.manage" },
] as const;

export const independentTrustHonoSurfaces = [
  { method: "GET", path: "/health", trustModel: "public_health" },
  { method: "POST", path: "/webhooks/stripe", trustModel: "stripe_signature" },
  {
    method: "POST",
    path: "/webhooks/tiktok/publication",
    trustModel: "provider_signature",
  },
  {
    method: "GET",
    path: "/social/oauth/callback",
    trustModel: "oauth_callback",
  },
] as const;

type ServerActionSurface =
  | {
      module: string;
      exportName: string;
      admission: "signed_in";
    }
  | {
      module: string;
      exportName: string;
      admission: "workspace" | "project";
      capability: WorkspaceCapability;
    };

const action = (
  module: string,
  exportName: string,
  admission: "workspace" | "project",
  capability: WorkspaceCapability,
): ServerActionSurface => ({ module, exportName, admission, capability });

const signedInAction = (
  module: string,
  exportName: string,
): ServerActionSurface => ({ module, exportName, admission: "signed_in" });

export const browserSessionServerActions: readonly ServerActionSurface[] = [
  action("app/(app)/_actions/workspace.ts", "switchWorkspaceAction", "workspace", "content.view"),
  action("app/(app)/calendar/actions.ts", "scheduleWorkspacePostAction", "project", "publishing.manage"),
  action("app/(app)/calendar/actions.ts", "cancelWorkspacePostAction", "project", "publishing.manage"),
  action("app/(app)/exports/actions.ts", "retryWorkspaceExportAction", "workspace", "processing.consume"),
  action("app/(app)/projects/actions.ts", "createFolderAction", "workspace", "content.edit"),
  action("app/(app)/projects/actions.ts", "deleteFolderAction", "workspace", "content.edit"),
  action("app/(app)/projects/actions.ts", "renameFolderAction", "workspace", "content.edit"),
  action("app/(app)/projects/actions.ts", "moveProjectToFolderAction", "project", "content.edit"),
  action("app/(app)/projects/actions.ts", "createProjectFormAction", "workspace", "content.edit"),
  action("app/(app)/projects/actions.ts", "queueTranscriptionFormAction", "project", "processing.consume"),
  action("app/(app)/projects/actions.ts", "queueGenerationFormAction", "project", "processing.consume"),
  action("app/(app)/projects/actions.ts", "applyProjectBrandProfileFormAction", "project", "content.edit"),
  action("app/(app)/projects/actions.ts", "regenerateClipsFormAction", "project", "processing.consume"),
  action("app/(app)/projects/actions.ts", "renderClipsFormAction", "project", "processing.consume"),
  action("app/(app)/projects/actions.ts", "retryIngestFormAction", "project", "processing.consume"),
  action("app/(app)/projects/actions.ts", "setNotifyPreferenceAction", "project", "content.edit"),
  action("app/(app)/projects/actions.ts", "deleteProjectFormAction", "project", "content.edit"),
  action("app/(app)/settings/actions.ts", "updateWorkspaceAction", "workspace", "workspace.manage"),
  action("app/(app)/settings/actions.ts", "inviteMemberAction", "workspace", "members.invite"),
  action("app/(app)/settings/actions.ts", "resendInviteAction", "workspace", "members.invite"),
  action("app/(app)/settings/actions.ts", "revokeInviteAction", "workspace", "members.invite"),
  action("app/(app)/settings/actions.ts", "changeMemberRoleAction", "workspace", "members.invite"),
  action("app/(app)/settings/actions.ts", "removeMemberAction", "workspace", "members.invite"),
  action("app/(app)/settings/actions.ts", "createApiKeyAction", "workspace", "api.manage"),
  action("app/(app)/settings/actions.ts", "revokeApiKeyAction", "workspace", "api.manage"),
  action("app/(app)/settings/brand-templates/actions.ts", "createBrandTemplateAction", "workspace", "brand.manage"),
  action("app/(app)/settings/brand-templates/actions.ts", "updateBrandTemplateAction", "workspace", "brand.manage"),
  action("app/(app)/settings/brand-templates/actions.ts", "deleteBrandTemplateAction", "workspace", "brand.manage"),
  action("app/(app)/settings/brand-templates/actions.ts", "setDefaultBrandTemplateAction", "workspace", "workspace.manage"),
  action("app/(app)/settings/brand-templates/actions.ts", "duplicateBrandTemplateAction", "workspace", "brand.manage"),
  action("app/(app)/upload/actions.ts", "commitLinkImportAction", "workspace", "processing.consume"),
  action("app/(app)/upload/actions.ts", "finalizeLinkConfigureAction", "project", "content.edit"),
  action("app/(app)/upload/actions.ts", "saveGenerationDraftAction", "project", "content.edit"),
  action("app/(app)/upload/actions.ts", "fetchYoutubeMetadataAction", "workspace", "content.view"),
  action("app/(app)/upload/actions.ts", "generateFromRssAction", "workspace", "processing.consume"),
  signedInAction("app/workspaces/new/actions.ts", "createBusinessWorkspaceAction"),
  signedInAction("app/actions/onboarding.ts", "completeOnboardingAction"),
  signedInAction("app/invite/[token]/actions.ts", "acceptWorkspaceInviteAction"),
  action("app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx", "fetchPreviewStatus", "project", "content.edit"),
  action("app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx", "fetchAutoLayoutAnalysis", "project", "content.edit"),
  action("app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx", "fetchSplitLayoutAnalysis", "project", "content.edit"),
  action("app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx", "fetchScreenLayoutAnalysis", "project", "content.edit"),
];

export const browserSessionServerActionModules = [
  ...new Set(browserSessionServerActions.map(({ module }) => module)),
];

type PageSurface =
  | { module: string; admission: "signed_in" }
  | {
      module: string;
      admission: "workspace" | "optional_workspace" | "project";
      capability: WorkspaceCapability;
    };

const page = (
  module: string,
  admission: PageSurface["admission"] = "workspace",
  capability: WorkspaceCapability = "content.view",
): PageSurface => ({ module, admission, capability });

const signedInPage = (module: string): PageSurface => ({
  module,
  admission: "signed_in",
});

export const browserSessionPages: readonly PageSurface[] = [
  page("app/(app)/autopilot/page.tsx"),
  page("app/(app)/calendar/new/page.tsx", "workspace", "publishing.manage"),
  page("app/(app)/calendar/page.tsx"),
  page("app/(app)/exports/page.tsx"),
  page("app/(app)/home/page.tsx"),
  page("app/(app)/integrations/mcp/page.tsx"),
  page("app/(app)/integrations/page.tsx"),
  page("app/(app)/layout.tsx", "optional_workspace"),
  page("app/(app)/projects/[projectId]/clips/[clipId]/edit/page.tsx", "project", "content.edit"),
  page("app/(app)/projects/[projectId]/clips/[clipId]/exports/[exportId]/page.tsx", "project", "content.download"),
  page("app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx", "project", "content.edit"),
  page("app/(app)/projects/[projectId]/page.tsx", "project"),
  page("app/(app)/projects/page.tsx"),
  page("app/(app)/settings/api/page.tsx", "workspace", "api.manage"),
  page("app/(app)/settings/billing/page.tsx"),
  page("app/(app)/settings/brand-templates/[id]/page.tsx"),
  page("app/(app)/settings/brand-templates/page.tsx"),
  page("app/(app)/settings/members/page.tsx"),
  page("app/(app)/settings/profile/page.tsx"),
  page("app/(app)/settings/social/page.tsx"),
  page("app/(app)/settings/usage/page.tsx"),
  page("app/(app)/settings/workspace/page.tsx"),
  page("app/(app)/settings/layout.tsx"),
  page("app/(app)/upload/page.tsx", "workspace", "processing.consume"),
  signedInPage("app/workspaces/new/page.tsx"),
  signedInPage("app/invite/[token]/page.tsx"),
  signedInPage("app/onboarding/page.tsx"),
];

export const browserSessionPageModules = browserSessionPages.map(
  ({ module }) => module,
);

export const browserSessionInheritedPageModules = [
  "app/(app)/brand-kit/[id]/page.tsx",
  "app/(app)/brand-kit/new/page.tsx",
  "app/(app)/brand-kit/page.tsx",
  "app/(app)/dashboard/page.tsx",
  "app/(app)/help/page.tsx",
  "app/(app)/projects/[projectId]/clips/[clipId]/studio/layout.tsx",
  "app/(app)/settings/brand-templates/new/page.tsx",
  "app/(app)/settings/notifications/page.tsx",
  "app/(app)/settings/page.tsx",
  "app/(app)/settings/social-accounts/page.tsx",
  "app/(app)/whats-new/page.tsx",
] as const;

export const browserSessionLongLivedModules = [
  "app/api/stream/[projectId]/route.ts",
] as const;

export const independentTrustModules = [
  { module: "app/api/webhooks/clerk/route.ts", trustModel: "clerk_signature" },
  { module: "app/mcp/route.ts", trustModel: "mcp_oauth_or_scoped_api_key" },
  {
    module: "app/auth/continue/route.ts",
    trustModel: "oauth_identity_continuation",
  },
  { module: "app/share/[token]/page.tsx", trustModel: "public_share_token" },
] as const;

function pathMatch(
  template: string,
  path: string,
): Record<string, string> | null {
  const names: string[] = [];
  const source = template
    .split("/")
    .map((part) => {
      if (!part.startsWith(":"))
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(part.slice(1));
      return "([^/]+)";
    })
    .join("/");
  const match = new RegExp(`^${source}$`).exec(path);
  if (!match) return null;
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      decodeURIComponent(match[index + 1] ?? ""),
    ]),
  );
}

export function matchBrowserSessionHonoSurface(
  method: string,
  path: string,
): {
  operationName: string;
  admission: AuthenticatedRequestAdmission;
  params: Readonly<Record<string, string>>;
  rateLimit?: {
    key(actor: { actorUserId: string; workspaceId: string }): string;
    limit: number;
    windowSeconds: number;
  };
  input?: HonoSurface["input"];
} | null {
  for (const surface of browserSessionHonoSurfaces) {
    if (surface.method !== method.toUpperCase()) continue;
    const params = pathMatch(surface.path, path);
    if (!params) continue;
    return {
      operationName: `${surface.method} ${surface.path}`,
      params,
      admission: surface.projectParam
        ? {
            kind: "project",
            capability: surface.capability,
            projectId: params[surface.projectParam] ?? "",
          }
        : { kind: "workspace", capability: surface.capability },
      ...(surface.rateLimit
        ? {
            rateLimit: {
              key: (actor: { actorUserId: string; workspaceId: string }) =>
                `${surface.rateLimit!.prefix}:${
                  surface.rateLimit!.scope === "actor"
                    ? actor.actorUserId
                    : actor.workspaceId
                }`,
              limit: surface.rateLimit.limit,
              windowSeconds: surface.rateLimit.windowSeconds,
            },
          }
        : {}),
      ...(surface.input ? { input: surface.input } : {}),
    };
  }
  return null;
}

export function isIndependentTrustHonoSurface(
  method: string,
  path: string,
): boolean {
  return independentTrustHonoSurfaces.some(
    (surface) =>
      surface.method === method.toUpperCase() && pathMatch(surface.path, path),
  );
}
