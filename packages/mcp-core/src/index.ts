import { McpServer } from "@modelcontextprotocol/server";
import {
  autopilotService,
  clipService,
  projectService,
  socialService,
  workspaceService,
  workspaceLibraryService,
} from "@narriflow/services";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  confirmSocialPublicationSchema,
  contentPackSchema,
} from "@narriflow/validators";
import * as z from "zod/v4";
import { McpToolAdmission, mcpToolFailure, type NarriflowMcpPrincipal } from "./mcp-tool-admission";

export { MCP_TOOL_ADMISSIONS, type NarriflowMcpToolName, type NarriflowMcpPrincipal } from "./mcp-tool-admission";

export const NARRIFLOW_MCP_SERVER_NAME = "narriflow";
export const NARRIFLOW_MCP_SERVER_VERSION = "0.2.0";

export const NARRIFLOW_MCP_INSTRUCTIONS =
  "Start with narriflow_list_workspaces and use the returned workspaceId for later calls. Narriflow data and billing are workspace-scoped. Read tools are safe; call write tools only when the user clearly asks. Rechecking a social publication inspects its existing provider operation and never submits a new post. Confirming publication requires evidence. Publishing again creates a new attempt and requires explicit duplicate-risk acknowledgement. MCP workspace access requires an active Business plan, and media processing still consumes the workspace's monthly minute quota.";

const workspaceInput = {
  workspaceId: z.string().uuid().optional().describe(
    "Narriflow workspace ID. Omit to use the personal workspace with OAuth or the key-bound workspace with an API key.",
  ),
};

const dataOutputSchema = z.object({ data: z.unknown() });

const readOnlyAnnotations = {
  readOnlyHint: true,
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

async function runTool(operation: () => Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    return mcpToolFailure(error);
  }
}

const toolAdmission = new McpToolAdmission(workspaceService);

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
    toneConstraints: ["concise", "conversational"],
    captionPreset: BRAND_DEFAULT_CAPTION_PRESET_ID,
    platformPlaybookVersion: "platform-playbook-v1",
    mode: "clip",
    autoHook: true,
    specificMoments: "",
    processingStartSec: null,
    processingEndSec: null,
    clipLengthPreset: "auto",
  });
}

export function buildNarriflowMcpServer(principal: NarriflowMcpPrincipal) {
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
      const actor = await toolAdmission.requireWorkspace(
        "narriflow_confirm_social_publication",
        principal,
        workspaceId,
      );
      logMutation("narriflow_confirm_social_publication", principal, actor.workspaceId);
      return socialService.confirmPublication(
        actor,
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
      const actor = await toolAdmission.requireWorkspace(
        "narriflow_create_rss_autopilot_rule",
        principal,
        input.workspaceId,
      );
      logMutation("narriflow_create_rss_autopilot_rule", principal, actor.workspaceId);
      return autopilotService.createRule(actor, {
        name: input.name,
        rssUrl: input.rssUrl,
        titlePrefix: input.titlePrefix ?? null,
        intervalMinutes: input.intervalMinutes ?? 1440,
        maxEpisodesPerRun: input.maxEpisodesPerRun ?? 3,
        contentPack: buildDefaultContentPack({
          clipCountTarget: input.clipCountTarget,
        }),
      });
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
      const actor = await toolAdmission.requireWorkspace("narriflow_get_project", principal, workspaceId);
      const project = await projectService.getProjectSnapshot(actor, projectId);
      if (!project.project) return { project: null, progress: null, transcript: null, clips: [] };
      const [transcript, clips] = await Promise.all([
        projectService.getTranscriptSnapshot(actor, projectId),
        clipService.listClips(actor, projectId),
      ]);
      return { project, progress: project.progress, transcript, clips };
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
      const actor = await toolAdmission.requireWorkspace(
        "narriflow_get_social_publication",
        principal,
        workspaceId,
      );
      return socialService.inspectPublication(actor, socialPostId);
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
      const actor = await toolAdmission.requireWorkspace("narriflow_get_workspace_usage", principal, workspaceId);
      return projectService.getUsageSummary(actor);
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
      const actor = await toolAdmission.requireWorkspace("narriflow_list_autopilot_rules", principal, workspaceId);
      return autopilotService.listRules(actor);
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
      const actor = await toolAdmission.requireWorkspace("narriflow_list_projects", principal, workspaceId);
      return workspaceLibraryService.listProjects(actor, {limit, cursor: cursor ?? null});
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
    async () => runTool(() => toolAdmission.listWorkspaces(principal)),
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
      const actor = await toolAdmission.requireWorkspace(
        "narriflow_run_autopilot_rule_now",
        principal,
        workspaceId,
      );
      logMutation("narriflow_run_autopilot_rule_now", principal, actor.workspaceId);
      return autopilotService.triggerRuleNow(actor, ruleId);
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
      const actor = await toolAdmission.requireWorkspace(
        "narriflow_publish_social_publication_again",
        principal,
        workspaceId,
      );
      logMutation("narriflow_publish_social_publication_again", principal, actor.workspaceId);
      return socialService.republishPublication(
        actor,
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
      const actor = await toolAdmission.requireWorkspace(
        "narriflow_recheck_social_publication",
        principal,
        workspaceId,
      );
      logMutation(
        "narriflow_recheck_social_publication",
        principal,
        actor.workspaceId,
      );
      return socialService.recheckPublication(
        actor,
        socialPostId,
        { reason },
      );
    }),
  );

  return server;
}
