import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildNarriflowMcpServer } from "@narriflow/mcp-core";
import { workspaceService } from "@narriflow/services";

const secret = process.env.NARRIFLOW_API_KEY?.trim();
if (!secret) {
  throw new Error(
    "NARRIFLOW_API_KEY is required for the Narriflow stdio MCP server",
  );
}

const key = await workspaceService.authenticateApiKey(secret);
if (!key) {
  throw new Error(
    "NARRIFLOW_API_KEY is invalid, revoked, or not workspace-scoped",
  );
}

serveStdio(() =>
  buildNarriflowMcpServer({
    kind: "api_key",
    userId: key.userId,
    clientId: `narriflow-api-key:${key.apiKeyId}`,
    apiKeyId: key.apiKeyId,
    workspaceId: key.workspaceId,
    scopes: key.scopes,
  }),
);
