import { McpServer } from "@modelcontextprotocol/server";
import {
  autopilotService,
  authorizeBusinessAutomation,
  BUSINESS_AUTOMATION_FAILURE_MESSAGE,
  BusinessAutomationAccessError,
  businessAutomationDomainErrorCode,
  clipService,
  createProductionBusinessAutomation,
  hasFeature,
  projectService,
  socialService,
  SocialPublicationRecoveryError,
  workspaceService,
  type BusinessAutomation,
  type BusinessAutomationActorContext,
  type BusinessAutomationPrincipal,
  type WorkspaceApiKeyScope,
  type WorkspaceApiKeyPrincipal,
  type WorkspaceCapability,
} from "@narriflow/services";
import {
  applyMotionSelectedSchema,
  applyProjectBrandProfileSelectedSchema,
  applySceneTemplateSchema,
  applyStyleSelectedSchema,
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  brandProfileListSchema,
  bulkScheduleAutomationSchema,
  confirmSocialPublicationSchema,
  contentPackSchema,
  createReviewRoundAutomationSchema,
  generateAssistedCopySchema,
  generatedMediaAutomationSubmitSchema,
  previewCampaignEditorActionSchema,
  requestThumbnailExtractionSchema,
} from "@narriflow/validators";
import * as z from "zod/v4";

export const NARRIFLOW_MCP_SERVER_NAME = "narriflow";
export const NARRIFLOW_MCP_SERVER_VERSION = "0.3.0";

/**
 * Stable public tool inventory. The live-client gate imports this list and
 * compares it with both HTTP and stdio discovery so adding a tool cannot leave
 * the executable integration contract behind.
 */
export const NARRIFLOW_MCP_TOOL_NAMES = [
  "narriflow_confirm_social_publication",
  "narriflow_create_rss_autopilot_rule",
  "narriflow_get_project",
  "narriflow_get_social_publication",
  "narriflow_get_workspace_usage",
  "narriflow_list_autopilot_rules",
  "narriflow_list_projects",
  "narriflow_list_workspaces",
  "narriflow_run_autopilot_rule_now",
  "narriflow_publish_social_publication_again",
  "narriflow_recheck_social_publication",
  "narriflow_list_brand_profiles",
  "narriflow_get_brand_profile",
  "narriflow_list_campaign_operations",
  "narriflow_apply_campaign_motion",
  "narriflow_get_campaign_editor_action_catalog",
  "narriflow_preview_campaign_editor_action",
  "narriflow_apply_campaign_brand_profile",
  "narriflow_apply_campaign_style",
  "narriflow_apply_campaign_scene_template",
  "narriflow_list_review_rounds",
  "narriflow_create_review_round",
  "narriflow_generate_assisted_copy",
  "narriflow_get_assisted_copy",
  "narriflow_request_thumbnail_extraction",
  "narriflow_get_thumbnail_extraction",
  "narriflow_schedule_campaign",
  "narriflow_submit_generated_media",
  "narriflow_get_generated_media_job",
] as const;

export const NARRIFLOW_MCP_INSTRUCTIONS =
  "Start with narriflow_list_workspaces and use the returned workspaceId for later calls. Narriflow data and billing are workspace-scoped. Read tools are safe; call write tools only when the user clearly asks. Business workflow mutations require caller idempotency keys and are safe to retry with the exact same request. Never request or expose review guest credentials, signed media URLs, raw editor patches, or provider controls. Rechecking a social publication inspects its existing provider operation and never submits a new post. Confirming publication requires evidence. Publishing again creates a new attempt and requires explicit duplicate-risk acknowledgement. MCP workspace access requires an active Business plan, and media processing still consumes the workspace's monthly minute quota.";

export type NarriflowMcpPrincipal =
  | {
      kind: "oauth";
      userId: string;
      clientId: string;
      scopes: string[];
    }
  | {
      kind: "api_key";
      userId: string;
      clientId: string;
      apiKeyId: string;
      workspaceId: string;
      scopes: string[];
    };

type AutomationAccessInput = {
  requestedWorkspaceId?: string;
  requiredScope: WorkspaceApiKeyScope;
  capability: WorkspaceCapability;
  integration: "mcp";
};

export interface NarriflowMcpDependencies {
  automation?: BusinessAutomation;
  authorize?: (
    principal: BusinessAutomationPrincipal,
    input: AutomationAccessInput,
  ) => Promise<BusinessAutomationActorContext>;
  revalidateApiKey?: (
    apiKeyId: string,
  ) => Promise<WorkspaceApiKeyPrincipal | null>;
}

const workspaceInput = {
  workspaceId: z.string().uuid().optional().describe(
    "Narriflow workspace ID. Omit to use the personal workspace with OAuth or the key-bound workspace with an API key.",
  ),
};

const dataOutputSchema = z.object({ data: z.unknown() });

const campaignOperationStatusSchema = z.object({
  operationId: z.string().uuid().nullable(),
  action: z.string().nullable(),
  status: z.string(),
  requestedCount: z.number().int().nonnegative(),
  counts: z.object({
    succeeded: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    ineligible: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  items: z.array(z.object({
    clipId: z.string().uuid().nullable(),
    expectedEditorRevision: z.number().int().nonnegative().nullable(),
    status: z.string(),
    errorCode: z.string().nullable(),
    settledAt: z.string().datetime().nullable(),
  })),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  replayed: z.boolean(),
});

const campaignOperationOutputSchema = z.object({
  data: campaignOperationStatusSchema,
});
const campaignOperationListOutputSchema = z.object({
  data: z.array(campaignOperationStatusSchema),
});
const campaignPreviewOutputSchema = z.object({
  data: z.object({
    action: z.string().nullable(),
    requestedCount: z.number().int().nonnegative(),
    counts: z.object({
      eligible: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      stale: z.number().int().nonnegative(),
      ineligible: z.number().int().nonnegative(),
    }),
    items: z.array(z.object({
      clipId: z.string().uuid().nullable(),
      expectedEditorRevision: z.number().int().nonnegative(),
      currentEditorRevision: z.number().int().nonnegative().nullable(),
      status: z.string(),
      code: z.string().nullable(),
    })),
  }),
});

const reviewRoundStatusSchema = z.object({
  roundId: z.string().uuid().nullable(),
  revision: z.number().int().nonnegative(),
  status: z.string(),
  approvalRequired: z.boolean(),
  allowDownloads: z.boolean(),
  sentAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  supersededAt: z.string().datetime().nullable(),
  decision: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  newerWorkAvailable: z.boolean(),
  items: z.array(z.object({
    itemId: z.string().uuid().nullable(),
    clipId: z.string().uuid().nullable(),
    exportId: z.string().uuid().nullable(),
    editorRevision: z.number().int().nonnegative(),
    required: z.boolean(),
    currentDecision: z.string().nullable(),
    newerWorkAvailable: z.boolean(),
  })),
  notificationStatus: z.array(z.object({
    kind: z.string().nullable(),
    status: z.string(),
    attemptCount: z.number().int().nonnegative(),
    failureCode: z.string().nullable(),
    sentAt: z.string().datetime().nullable(),
  })),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});

const reviewRoundListOutputSchema = z.object({
  data: z.object({
    projectId: z.string().uuid().nullable(),
    rounds: z.array(reviewRoundStatusSchema),
  }),
});

const assistedCopyStatusSchema = z.object({
  draftId: z.string().uuid().nullable(),
  clipId: z.string().uuid().nullable(),
  platform: z.string().nullable(),
  status: z.string(),
  revision: z.number().int().nonnegative(),
  content: z.unknown().nullable(),
  confirmed: z.boolean(),
  moderationOutcome: z.string(),
  modelAlias: z.string().nullable(),
  promptVersion: z.string().nullable(),
  guidanceSkipped: z.boolean(),
  errorCode: z.string().nullable(),
  replayed: z.boolean(),
});

const thumbnailStatusSchema = z.object({
  jobId: z.string().uuid().nullable(),
  status: z.string(),
  attempts: z.number().int().nonnegative(),
  platform: z.string().nullable(),
  exportVariantId: z.string().uuid().nullable(),
  sourceTimeMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  asset: z.unknown().nullable(),
  replayed: z.boolean(),
});

const generatedMediaStatusSchema = z.object({
  jobId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  clipId: z.string().uuid().nullable(),
  kind: z.string().nullable(),
  status: z.string(),
  aspectRatio: z.string().nullable(),
  style: z.string().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  resultAssetId: z.string().uuid().nullable(),
  insertionCount: z.number().int().nonnegative(),
  lastInsertionKind: z.string().nullable(),
  lastInsertedAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  moderationOutcome: z.string(),
  createdAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
  replayed: z.boolean(),
});

const reviewRoundCreatedOutputSchema = z.object({
  data: z.object({
    roundId: z.string().uuid().nullable(),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime().nullable(),
    replayed: z.boolean(),
  }),
});
const assistedCopyOutputSchema = z.object({ data: assistedCopyStatusSchema });
const thumbnailOutputSchema = z.object({ data: thumbnailStatusSchema });
const generatedMediaOutputSchema = z.object({ data: generatedMediaStatusSchema });
const bulkScheduleOutputSchema = z.object({
  data: z.object({
    operationId: z.string().uuid().nullable(),
    status: z.string(),
    counts: z.object({
      scheduled: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    items: z.array(z.object({
      itemKey: z.string().uuid().nullable(),
      clipId: z.string().uuid().nullable(),
      accountId: z.string().uuid().nullable(),
      status: z.string(),
      postId: z.string().uuid().nullable(),
      scheduledFor: z.string().datetime().nullable(),
      errorCode: z.string().nullable(),
    })),
    replayed: z.boolean(),
  }),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const idempotentMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function success(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}

function exactAssistedCopyStatus(data: unknown) {
  return assistedCopyStatusSchema.parse(data);
}

function failure(error: unknown) {
  const accessError = error instanceof BusinessAutomationAccessError ? error : null;
  const domainCode = businessAutomationDomainErrorCode(error);
  const apiKeyScope = error instanceof Error && error.message.startsWith("This API key requires");
  const workspaceBoundary =
    error instanceof Error && error.message === "This API key is bound to a different workspace";
  const billingBoundary = error instanceof Error && error.message.startsWith("Narriflow MCP ");
  const payload = error instanceof SocialPublicationRecoveryError
    ? { error: error.code, message: error.message }
    : accessError
      ? {
          error: `mcp_${accessError.code}`,
          message: accessError.message,
        }
    : domainCode
      ? {
          error: domainCode,
          message: BUSINESS_AUTOMATION_FAILURE_MESSAGE,
        }
    : apiKeyScope
      ? { error: "mcp_api_key_scope_required", message: error.message }
      : workspaceBoundary
        ? { error: "mcp_workspace_boundary_violation", message: error.message }
        : billingBoundary
          ? { error: "mcp_workspace_access_unavailable", message: error.message }
          : {
              error: "narriflow_tool_failed",
              message: "Narriflow tool failed without exposing internal details",
            };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: { data: payload },
  };
}

async function runTool(operation: () => Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

async function revalidateMcpPrincipal(
  principal: NarriflowMcpPrincipal,
  revalidateApiKey: NonNullable<NarriflowMcpDependencies["revalidateApiKey"]> =
    (apiKeyId) => workspaceService.getActiveApiKeyPrincipal(apiKeyId),
): Promise<NarriflowMcpPrincipal> {
  if (principal.kind === "oauth") return principal;
  const current = await revalidateApiKey(principal.apiKeyId);
  if (
    !current ||
    current.apiKeyId !== principal.apiKeyId ||
    current.userId !== principal.userId ||
    current.workspaceId !== principal.workspaceId
  ) {
    throw new BusinessAutomationAccessError(
      "api_key_invalid",
      "API key is invalid or revoked",
    );
  }
  return {
    ...principal,
    scopes: [...current.scopes],
  };
}

async function requireWorkspace(
  principal: NarriflowMcpPrincipal,
  requestedWorkspaceId: string | undefined,
  capability: WorkspaceCapability,
  apiKeyScope: WorkspaceApiKeyScope,
  authorize: NarriflowMcpDependencies["authorize"] = authorizeBusinessAutomation,
  revalidateApiKey?: NarriflowMcpDependencies["revalidateApiKey"],
) {
  const currentPrincipal = await revalidateMcpPrincipal(
    principal,
    revalidateApiKey,
  );
  return authorize(currentPrincipal, {
    requestedWorkspaceId,
    requiredScope: apiKeyScope,
    capability,
    integration: "mcp",
  });
}

function logMutation(tool: string, principal: NarriflowMcpPrincipal, workspaceId: string) {
  console.warn(JSON.stringify({
    level: "info",
    message: "mcp_tool_invoked",
    tool,
    userId: principal.userId,
    workspaceId,
    clientId: principal.clientId,
    credentialType: principal.kind,
  }));
}

function buildDefaultContentPack(input: {
  clipCountTarget?: number;
  autoRenderClips?: boolean;
}) {
  return contentPackSchema.parse({
    outputTypes: ["short_clip"],
    clipGenerationMode: "best",
    clipCountTarget: input.clipCountTarget ?? 10,
    clipDurationSecTarget: 45,
    minDurationSec: 15,
    preferredMinDurationSec: 30,
    preferredMaxDurationSec: 60,
    maxDurationSec: 90,
    platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
    autoRenderClips: input.autoRenderClips ?? true,
    toneConstraints: ["concise", "conversational"],
    captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
    platformPlaybookVersion: "2026.2",
    mode: "clip",
    autoHook: true,
    specificMoments: "",
    processingStartSec: null,
    processingEndSec: null,
    clipLengthPreset: "auto",
  });
}

export function buildNarriflowMcpServer(
  principal: NarriflowMcpPrincipal,
  dependencies: NarriflowMcpDependencies = {},
) {
  const automation =
    dependencies.automation ?? createProductionBusinessAutomation();
  const requireCurrentWorkspace = (
    requestedWorkspaceId: string | undefined,
    capability: WorkspaceCapability,
    apiKeyScope: WorkspaceApiKeyScope,
  ) => requireWorkspace(
    principal,
    requestedWorkspaceId,
    capability,
    apiKeyScope,
    dependencies.authorize,
    dependencies.revalidateApiKey,
  );
  const requireAutomationWorkspace = requireCurrentWorkspace;
  const server = new McpServer(
    { name: NARRIFLOW_MCP_SERVER_NAME, version: NARRIFLOW_MCP_SERVER_VERSION },
    {
      instructions: NARRIFLOW_MCP_INSTRUCTIONS,
      cacheHints: {
        "server/discover": { ttlMs: 5 * 60_000, cacheScope: "public" },
        "tools/list": { ttlMs: 5 * 60_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "narriflow_confirm_social_publication",
    {
      title: "Confirm social publication",
      description:
        "Record operator evidence that a Needs attention publication exists on the provider. This settles the existing attempt without submitting another post.",
      inputSchema: confirmSocialPublicationSchema.extend({
        ...workspaceInput,
        socialPostId: z.string().uuid(),
      }),
      outputSchema: dataOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ socialPostId, reason, evidenceKind, providerReference, externalUrl, workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(
        workspaceId,
        "publishing.manage",
        "publishing:write",
      );
      logMutation("narriflow_confirm_social_publication", principal, actor.workspaceId);
      return socialService.confirmPublication(
        actor.workspaceId,
        principal.userId,
        socialPostId,
        {
          reason,
          evidenceKind,
          providerReference: providerReference ?? null,
          externalUrl: externalUrl ?? null,
        },
      );
    }),
  );

  server.registerTool(
    "narriflow_create_rss_autopilot_rule",
    {
      title: "Create RSS autopilot rule",
      description: "Create a workspace RSS rule that imports new episodes and queues clip generation.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        name: z.string().min(1).max(120),
        rssUrl: z.url(),
        titlePrefix: z.string().min(1).max(100).nullable().optional(),
        intervalMinutes: z.number().int().min(60).max(10080).optional(),
        maxEpisodesPerRun: z.number().int().min(1).max(10).optional(),
        clipCountTarget: z.number().int().min(3).max(30).optional(),
        autoRenderClips: z.boolean().optional(),
      }),
      outputSchema: dataOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => runTool(async () => {
      const actor = await requireCurrentWorkspace(
        input.workspaceId,
        "content.edit",
        "autopilot:write",
      );
      logMutation("narriflow_create_rss_autopilot_rule", principal, actor.workspaceId);
      return autopilotService.createRule(actor.workspaceOwnerUserId, {
        name: input.name,
        rssUrl: input.rssUrl,
        titlePrefix: input.titlePrefix ?? null,
        intervalMinutes: input.intervalMinutes ?? 1440,
        maxEpisodesPerRun: input.maxEpisodesPerRun ?? 3,
        contentPack: buildDefaultContentPack({
          clipCountTarget: input.clipCountTarget,
          autoRenderClips: input.autoRenderClips,
        }),
      }, { workspaceId: actor.workspaceId, actorUserId: principal.userId });
    }),
  );

  server.registerTool(
    "narriflow_get_project",
    {
      title: "Get Narriflow project",
      description: "Fetch one project, its transcript summary, and its detected clips.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectId, workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(workspaceId, "content.view", "projects:read");
      const project = await projectService.getProjectSnapshot(
        principal.userId,
        projectId,
        actor.workspaceId,
      );
      if (!project.project) return { project: null, transcript: null, clips: [] };
      const [transcript, clips] = await Promise.all([
        projectService.getTranscriptSnapshot(actor.workspaceOwnerUserId, projectId),
        clipService.listClips(actor.workspaceOwnerUserId, projectId),
      ]);
      return { project, transcript, clips };
    }),
  );

  server.registerTool(
    "narriflow_get_social_publication",
    {
      title: "Get social publication recovery facts",
      description:
        "Inspect one social publication, its attempt outcomes, allowed recovery evidence, and manual decisions without exposing provider checkpoint state.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        socialPostId: z.string().uuid(),
      }),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ socialPostId, workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(
        workspaceId,
        "content.view",
        "publishing:read",
      );
      return socialService.inspectPublication(actor.workspaceId, socialPostId);
    }),
  );

  server.registerTool(
    "narriflow_get_workspace_usage",
    {
      title: "Get workspace usage",
      description: "Get the workspace plan, monthly processing-minute usage, and upload limit.",
      inputSchema: z.object(workspaceInput),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(workspaceId, "content.view", "usage:read");
      return projectService.getUsageSummary(actor.workspaceOwnerUserId, actor.workspaceId);
    }),
  );

  server.registerTool(
    "narriflow_list_autopilot_rules",
    {
      title: "List RSS autopilot rules",
      description: "List RSS autopilot rules in a Narriflow workspace.",
      inputSchema: z.object(workspaceInput),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(workspaceId, "content.view", "autopilot:read");
      return autopilotService.listRules(actor.workspaceOwnerUserId, actor.workspaceId);
    }),
  );

  server.registerTool(
    "narriflow_list_projects",
    {
      title: "List Narriflow projects",
      description: "List workspace projects with clip and processing statistics.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().nullable().optional(),
      }),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, limit, cursor }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(workspaceId, "content.view", "projects:read");
      return projectService.listProjectsWithStatsPage(principal.userId, {
        limit,
        cursor: cursor ?? null,
        workspaceId: actor.workspaceId,
      });
    }),
  );

  server.registerTool(
    "narriflow_list_workspaces",
    {
      title: "List Narriflow workspaces",
      description: "List workspaces available to the authenticated Narriflow user or API key.",
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async () => runTool(async () => {
      const currentPrincipal = await revalidateMcpPrincipal(
        principal,
        dependencies.revalidateApiKey,
      );
      if (currentPrincipal.kind === "api_key") {
        const actor = await workspaceService.requireActor(
          currentPrincipal.userId,
          currentPrincipal.workspaceId,
          "content.view",
        );
        const workspace = await workspaceService.getWorkspace(
          currentPrincipal.userId,
          currentPrincipal.workspaceId,
        );
        return workspace ? [{
          ...workspace,
          role: actor.role,
          mcpEnabled: actor.status === "active" && hasFeature(actor.pricingTier, "integrations.mcp"),
        }] : [];
      }
      const memberships = await workspaceService.listAccessibleWorkspaces(
        currentPrincipal.userId,
      );
      return memberships.map(({ role, workspace }) => ({
        id: workspace.id,
        name: workspace.name,
        role,
        status: workspace.status,
        pricingTier: workspace.pricingTier,
        isPersonal: workspace.personalOwnerUserId === currentPrincipal.userId,
        mcpEnabled:
          workspace.status === "active" && hasFeature(workspace.pricingTier, "integrations.mcp"),
      }));
    }),
  );

  server.registerTool(
    "narriflow_run_autopilot_rule_now",
    {
      title: "Run autopilot rule now",
      description: "Mark an RSS autopilot rule due so the worker checks it on its next poll.",
      inputSchema: z.object({
        ...workspaceInput,
        ruleId: z.string().uuid(),
      }),
      outputSchema: dataOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ruleId, workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(
        workspaceId,
        "content.edit",
        "autopilot:write",
      );
      logMutation("narriflow_run_autopilot_rule_now", principal, actor.workspaceId);
      return autopilotService.triggerRuleNow(
        actor.workspaceOwnerUserId,
        ruleId,
        { workspaceId: actor.workspaceId, actorUserId: principal.userId },
      );
    }),
  );

  server.registerTool(
    "narriflow_publish_social_publication_again",
    {
      title: "Publish social publication again",
      description:
        "Fence the uncertain provider operation and create a new publication attempt. This may create a duplicate post and requires explicit acknowledgement.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        socialPostId: z.string().uuid(),
        reason: z.string().trim().min(1).max(500),
        duplicateRiskAcknowledged: z.literal(true),
      }),
      outputSchema: dataOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ socialPostId, reason, duplicateRiskAcknowledged, workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(
        workspaceId,
        "publishing.manage",
        "publishing:write",
      );
      logMutation("narriflow_publish_social_publication_again", principal, actor.workspaceId);
      return socialService.republishPublication(
        actor.workspaceId,
        principal.userId,
        socialPostId,
        { reason, duplicateRiskAcknowledged },
      );
    }),
  );

  server.registerTool(
    "narriflow_recheck_social_publication",
    {
      title: "Recheck social publication",
      description:
        "Queue a targeted read-only reconciliation of the existing provider operation. This cannot create a new Social Publication Attempt or submit another post.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        socialPostId: z.string().uuid(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: dataOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ socialPostId, reason, workspaceId }) => runTool(async () => {
      const actor = await requireCurrentWorkspace(
        workspaceId,
        "publishing.manage",
        "publishing:write",
      );
      logMutation(
        "narriflow_recheck_social_publication",
        principal,
        actor.workspaceId,
      );
      return socialService.recheckPublication(
        actor.workspaceId,
        principal.userId,
        socialPostId,
        { reason },
      );
    }),
  );

  server.registerTool(
    "narriflow_list_brand_profiles",
    {
      title: "List brand profiles",
      description:
        "List workspace brand profiles without returning signed asset or font URLs.",
      inputSchema: brandProfileListSchema.extend(workspaceInput),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, cursor, limit, query, includeDeleted }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "brand:read",
      );
      return automation.listBrandProfiles(actor, {
        cursor,
        limit,
        query,
        includeDeleted,
      });
    }),
  );

  server.registerTool(
    "narriflow_get_brand_profile",
    {
      title: "Get brand profile",
      description:
        "Get one profile owned by the selected Workspace tenant without signed asset or font URLs.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        profileId: z.string().uuid(),
      }),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, profileId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "brand:read",
      );
      return automation.getBrandProfile(actor, profileId);
    }),
  );

  server.registerTool(
    "narriflow_list_campaign_operations",
    {
      title: "List campaign operations",
      description:
        "Read typed status for durable, selection-scoped campaign operations.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: campaignOperationListOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, projectId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "campaign:operate",
      );
      return automation.listCampaignOperations(actor, projectId);
    }),
  );

  server.registerTool(
    "narriflow_apply_campaign_motion",
    {
      title: "Apply campaign motion",
      description:
        "Apply a validated transition or manual B-roll motion to explicitly revision-fenced clips.",
      inputSchema: applyMotionSelectedSchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
        idempotencyKey: z.string().uuid(),
      }),
      outputSchema: campaignOperationOutputSchema,
      annotations: idempotentMutationAnnotations,
    },
    async ({ workspaceId, projectId, idempotencyKey, change, clips }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.edit",
        "campaign:operate",
      );
      logMutation("narriflow_apply_campaign_motion", principal, actor.workspaceId);
      return automation.applyCampaignMotion(
        actor,
        projectId,
        idempotencyKey,
        { change, clips },
      );
    }),
  );

  server.registerTool(
    "narriflow_get_campaign_editor_action_catalog",
    {
      title: "Get campaign editor-action catalog",
      description:
        "Read the frozen project brand plus eligible styles and intro or outro scenes without media URLs.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: dataOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, projectId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "campaign:operate",
      );
      return automation.getCampaignEditorActionCatalog(actor, projectId);
    }),
  );

  server.registerTool(
    "narriflow_preview_campaign_editor_action",
    {
      title: "Preview campaign editor action",
      description:
        "Preview eligibility, unchanged clips, and revision conflicts for a high-level campaign action without returning editor patches.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
        request: previewCampaignEditorActionSchema,
      }),
      outputSchema: campaignPreviewOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, projectId, request }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "campaign:operate",
      );
      return automation.previewCampaignEditorAction(actor, projectId, request);
    }),
  );

  server.registerTool(
    "narriflow_apply_campaign_brand_profile",
    {
      title: "Apply campaign brand profile",
      description:
        "Apply the project-frozen brand profile to explicitly revision-fenced clips without accepting a profile override.",
      inputSchema: applyProjectBrandProfileSelectedSchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
        idempotencyKey: z.string().uuid(),
      }),
      outputSchema: campaignOperationOutputSchema,
      annotations: idempotentMutationAnnotations,
    },
    async ({ workspaceId, projectId, idempotencyKey, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.edit",
        "campaign:operate",
      );
      logMutation(
        "narriflow_apply_campaign_brand_profile",
        principal,
        actor.workspaceId,
      );
      return automation.applyCampaignBrandProfile(
        actor,
        projectId,
        idempotencyKey,
        input,
      );
    }),
  );

  server.registerTool(
    "narriflow_apply_campaign_style",
    {
      title: "Apply campaign style",
      description:
        "Apply one owned Brand Template to explicitly revision-fenced clips.",
      inputSchema: applyStyleSelectedSchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
        idempotencyKey: z.string().uuid(),
      }),
      outputSchema: campaignOperationOutputSchema,
      annotations: idempotentMutationAnnotations,
    },
    async ({ workspaceId, projectId, idempotencyKey, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.edit",
        "campaign:operate",
      );
      logMutation("narriflow_apply_campaign_style", principal, actor.workspaceId);
      return automation.applyCampaignStyle(
        actor,
        projectId,
        idempotencyKey,
        input,
      );
    }),
  );

  server.registerTool(
    "narriflow_apply_campaign_scene_template",
    {
      title: "Apply campaign scene template",
      description:
        "Insert one owned intro or outro Scene Template into explicitly revision-fenced clips.",
      inputSchema: applySceneTemplateSchema.safeExtend({
        ...workspaceInput,
        projectId: z.string().uuid(),
        profileId: z.string().uuid(),
        templateId: z.string().uuid(),
        idempotencyKey: z.string().uuid(),
      }),
      outputSchema: campaignOperationOutputSchema,
      annotations: idempotentMutationAnnotations,
    },
    async ({
      workspaceId,
      projectId,
      profileId,
      templateId,
      idempotencyKey,
      ...input
    }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.edit",
        "campaign:operate",
      );
      logMutation(
        "narriflow_apply_campaign_scene_template",
        principal,
        actor.workspaceId,
      );
      return automation.applyCampaignSceneTemplate(
        actor,
        projectId,
        profileId,
        templateId,
        idempotencyKey,
        input,
      );
    }),
  );

  server.registerTool(
    "narriflow_list_review_rounds",
    {
      title: "List review rounds",
      description:
        "Read review decisions and notification status without guest tokens, passcodes, recipients, or comments.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: reviewRoundListOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, projectId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "review:read",
      );
      return automation.listReviewRounds(actor, projectId);
    }),
  );

  server.registerTool(
    "narriflow_create_review_round",
    {
      title: "Create review round",
      description:
        "Create or replay a revision-fenced review round. The result never returns its guest access token or passcode.",
      inputSchema: createReviewRoundAutomationSchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: reviewRoundCreatedOutputSchema,
      annotations: {
        ...idempotentMutationAnnotations,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, projectId, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "review.manage",
        "review:write",
      );
      logMutation("narriflow_create_review_round", principal, actor.workspaceId);
      return automation.createReviewRound(actor, projectId, input);
    }),
  );

  server.registerTool(
    "narriflow_generate_assisted_copy",
    {
      title: "Generate assisted copy",
      description:
        "Generate or replay platform-specific campaign copy through the same guarded workflow used by the web app.",
      inputSchema: generateAssistedCopySchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: assistedCopyOutputSchema,
      annotations: {
        ...idempotentMutationAnnotations,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, projectId, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "publishing.manage",
        "publishing:prepare",
      );
      logMutation("narriflow_generate_assisted_copy", principal, actor.workspaceId);
      return exactAssistedCopyStatus(
        await automation.generateAssistedCopy(actor, projectId, input),
      );
    }),
  );

  server.registerTool(
    "narriflow_get_assisted_copy",
    {
      title: "Get assisted copy",
      description: "Read typed status for one workspace-owned assisted-copy draft.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
        draftId: z.string().uuid(),
      }),
      outputSchema: assistedCopyOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, projectId, draftId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "publishing:prepare",
      );
      return exactAssistedCopyStatus(
        await automation.getAssistedCopy(actor, projectId, draftId),
      );
    }),
  );

  server.registerTool(
    "narriflow_request_thumbnail_extraction",
    {
      title: "Request thumbnail extraction",
      description:
        "Create or replay a durable thumbnail extraction job from an owned export variant.",
      inputSchema: requestThumbnailExtractionSchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: thumbnailOutputSchema,
      annotations: idempotentMutationAnnotations,
    },
    async ({ workspaceId, projectId, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "publishing.manage",
        "publishing:prepare",
      );
      logMutation(
        "narriflow_request_thumbnail_extraction",
        principal,
        actor.workspaceId,
      );
      return automation.requestThumbnailExtraction(actor, projectId, input);
    }),
  );

  server.registerTool(
    "narriflow_get_thumbnail_extraction",
    {
      title: "Get thumbnail extraction",
      description:
        "Read typed status for one workspace-owned extraction job without storage keys or signed URLs.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        projectId: z.string().uuid(),
        jobId: z.string().uuid(),
      }),
      outputSchema: thumbnailOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, projectId, jobId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "publishing:prepare",
      );
      return automation.getThumbnailExtraction(actor, projectId, jobId);
    }),
  );

  server.registerTool(
    "narriflow_schedule_campaign",
    {
      title: "Schedule campaign",
      description:
        "Validate approval, revision, account, copy, thumbnail, and export ownership before scheduling a campaign batch.",
      inputSchema: bulkScheduleAutomationSchema.extend({
        ...workspaceInput,
        projectId: z.string().uuid(),
      }),
      outputSchema: bulkScheduleOutputSchema,
      annotations: {
        ...idempotentMutationAnnotations,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, projectId, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "publishing.manage",
        "publishing:prepare",
      );
      logMutation("narriflow_schedule_campaign", principal, actor.workspaceId);
      return automation.bulkSchedule(actor, projectId, input);
    }),
  );

  server.registerTool(
    "narriflow_submit_generated_media",
    {
      title: "Submit generated media",
      description:
        "Submit or replay a high-level image or enabled short-video generation job without provider or model controls.",
      inputSchema: generatedMediaAutomationSubmitSchema.safeExtend(workspaceInput),
      outputSchema: generatedMediaOutputSchema,
      annotations: {
        ...idempotentMutationAnnotations,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, ...input }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.edit",
        "generated-media:submit",
      );
      logMutation("narriflow_submit_generated_media", principal, actor.workspaceId);
      return automation.submitGeneratedMedia(actor, input);
    }),
  );

  server.registerTool(
    "narriflow_get_generated_media_job",
    {
      title: "Get generated-media job",
      description:
        "Read typed status for a workspace-owned job without prompts, source text, provider controls, payloads, or signed URLs.",
      inputSchema: z.strictObject({
        ...workspaceInput,
        jobId: z.string().uuid(),
      }),
      outputSchema: generatedMediaOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ workspaceId, jobId }) => runTool(async () => {
      const actor = await requireAutomationWorkspace(
        workspaceId,
        "content.view",
        "generated-media:submit",
      );
      return automation.getGeneratedMedia(actor, jobId);
    }),
  );

  return server;
}
