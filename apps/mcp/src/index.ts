import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  autopilotService,
  clipService,
  projectService,
} from "@narriflow/services";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  contentPackSchema,
} from "@narriflow/validators";

function requireUserId() {
  const userId = process.env.NARRIFLOW_MCP_USER_ID?.trim();
  if (!userId) {
    throw new Error("NARRIFLOW_MCP_USER_ID is required");
  }
  return userId;
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
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

const server = new McpServer({
  name: "narriflow",
  version: "0.1.0",
});

server.registerTool(
  "narriflow_list_projects",
  {
    title: "List Narriflow projects",
    description: "List the current MCP user's Narriflow projects with clip stats.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().nullable().optional(),
    },
  },
  async ({ limit, cursor }) => {
    const userId = requireUserId();
    const page = await projectService.listProjectsWithStatsPage(userId, {
      limit,
      cursor: cursor ?? null,
    });
    return jsonContent(page);
  },
);

server.registerTool(
  "narriflow_get_project",
  {
    title: "Get Narriflow project",
    description:
      "Fetch a project snapshot, transcript summary, and detected clips for the current MCP user.",
    inputSchema: {
      projectId: z.string().uuid(),
    },
  },
  async ({ projectId }) => {
    const userId = requireUserId();
    const [project, transcript, clips] = await Promise.all([
      projectService.getProjectSnapshot(userId, projectId),
      projectService.getTranscriptSnapshot(userId, projectId),
      clipService.listClips(userId, projectId),
    ]);
    return jsonContent({ project, transcript, clips });
  },
);

server.registerTool(
  "narriflow_create_rss_autopilot_rule",
  {
    title: "Create RSS autopilot rule",
    description:
      "Create an RSS autopilot rule that imports new episodes and queues Narriflow generation.",
    inputSchema: {
      name: z.string().min(1).max(120),
      rssUrl: z.string().url(),
      titlePrefix: z.string().min(1).max(100).nullable().optional(),
      intervalMinutes: z.number().int().min(60).max(10080).optional(),
      maxEpisodesPerRun: z.number().int().min(1).max(10).optional(),
      clipCountTarget: z.number().int().min(3).max(30).optional(),
      autoRenderClips: z.boolean().optional(),
    },
  },
  async (input) => {
    const userId = requireUserId();
    const rule = await autopilotService.createRule(userId, {
      name: input.name,
      rssUrl: input.rssUrl,
      titlePrefix: input.titlePrefix ?? null,
      intervalMinutes: input.intervalMinutes ?? 1440,
      maxEpisodesPerRun: input.maxEpisodesPerRun ?? 3,
      contentPack: buildDefaultContentPack({
        clipCountTarget: input.clipCountTarget,
        autoRenderClips: input.autoRenderClips,
      }),
    });
    return jsonContent(rule);
  },
);

server.registerTool(
  "narriflow_run_autopilot_rule_now",
  {
    title: "Run autopilot rule now",
    description:
      "Mark an RSS autopilot rule due so the Narriflow worker runs it on the next poll.",
    inputSchema: {
      ruleId: z.string().uuid(),
    },
  },
  async ({ ruleId }) => {
    const userId = requireUserId();
    const rule = await autopilotService.triggerRuleNow(userId, ruleId);
    return jsonContent(rule);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
