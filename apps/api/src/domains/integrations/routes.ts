import { mcpConfirmationSchema, mcpPreparationQuerySchema, mcpUploadHandoffQuerySchema, type McpConfirmationInput, type McpPreparationData, type McpUploadHandoffData } from "@narriflow/validators/api/integrations";
import { createRouteApp, getActor, getSignedInActor, getRecordedRateLimit } from "../../http/admission";
import type { BrowserActorScope } from "../../http/request-policy-runtime";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { integrationsAdmission } from "./admission";
import type { inspectMcpConfiguration } from "./mcp-configuration";

export interface IntegrationsRouteDeps {
  status(actor: BrowserActorScope): Promise<{
    mcpUrl: string;
    configuration: Awaited<ReturnType<typeof inspectMcpConfiguration>>;
    workspace: { workspaceId: string; workspaceName: string; role: BrowserActorScope["role"]; status: BrowserActorScope["status"]; pricingTier: string };
  }>;
  preparation(userId: string, token: string): Promise<McpPreparationData>;
  uploadHandoff(userId: string, token: string): Promise<McpUploadHandoffData>;
  confirm(userId: string, input: McpConfirmationInput, beforeAccept: () => void): Promise<{ destination: string }>;
}

export function createIntegrationsRoutes(deps: IntegrationsRouteDeps) {
  return createRouteApp(integrationsAdmission)
    .get("/integrations/mcp/status", async (c) => c.json(await deps.status(getActor(c)), 200))
    .get("/integrations/mcp/preparations", validate("query", mcpPreparationQuerySchema), async (c) =>
      c.json(await deps.preparation(getSignedInActor(c).actorUserId, c.req.valid("query").token), 200))
    .get("/integrations/mcp/upload-handoff", validate("query", mcpUploadHandoffQuerySchema), async (c) =>
      c.json(await deps.uploadHandoff(getSignedInActor(c).actorUserId, c.req.valid("query").intent), 200))
    .post("/mcp/confirmations", validate("json", mcpConfirmationSchema), async (c) =>
      c.json(await deps.confirm(getSignedInActor(c).actorUserId, c.req.valid("json"), () => enforceRecordedRateLimit(getRecordedRateLimit(c))), 200));
}

export type IntegrationsRoutes = ReturnType<typeof createIntegrationsRoutes>;
