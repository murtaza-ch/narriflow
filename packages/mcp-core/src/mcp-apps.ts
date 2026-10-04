import { registerAppResource, registerAppTool, getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { type McpServer, type CallToolResult, type ClientCapabilities, type ServerContext, ProtocolError } from "@modelcontextprotocol/server";
import { openUploadSessionSchema, readUploadSessionSchema, grantUploadPartsSchema, finalizeUploadSessionSchema, discardUploadSessionSchema, mcpAppTransferResultSchema, mcpAppConfirmationResultSchema, mcpAppConfirmIntentSchema } from "@narriflow/validators";
import { z } from "zod";
import { narriflowAppHtml } from "./mcp-apps/v2/document";

export type NarriflowAppView = "upload" | "progress" | "clip-review" | "publication-confirmation";
export type NarriflowUploadAction = "open" | "status" | "grants" | "finalize" | "discard";
const views: NarriflowAppView[] = ["upload", "progress", "clip-review", "publication-confirmation"];

export function getNarriflowAppToolMeta(view: NarriflowAppView) {
  return { ui: { resourceUri: `ui://narriflow/v2/${view}.html`, visibility: ["model", "app"] as Array<"model" | "app"> } };
}
export function supportsNarriflowApps(capabilities?: ClientCapabilities | null, protocolEra: "modern" | "legacy" = "modern") {
  // Stateless legacy requests cannot retain initialize capabilities. Their host
  // negotiates the App bridge and enforces app-only visibility; domain auth still applies.
  if (capabilities == null && protocolEra === "legacy") return true;
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) === true;
}

export interface NarriflowMcpAppsOptions {
  appOrigin: string;
  protocolEra?: "modern" | "legacy";
  connectDomains?: string[];
  resourceDomains?: string[];
  callUpload?: (action: NarriflowUploadAction, input: Record<string, unknown>) => Promise<CallToolResult>;
  acceptPublication?: (input: { workspaceId: string; token: string; accepted: boolean }) => Promise<CallToolResult>;
}
function requestCapabilities(context: ServerContext, server: McpServer): ClientCapabilities | undefined {
  const value = (context.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"];
  return value && typeof value === "object" ? value as ClientCapabilities : server.server.getClientCapabilities();
}
function origin(value: string) {
  const url = new URL(value);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.origin !== value.replace(/\/$/, "")) throw new Error("App CSP domains must be complete HTTP origins");
  return url.origin;
}

/** Resources are immutable templates. Private tool outcomes are delivered by the
 * host bridge and must use private, zero-TTL caching in the server factory. */
export function registerNarriflowMcpApps(server: McpServer, options: NarriflowMcpAppsOptions) {
  const appOrigin = origin(options.appOrigin);
  const storageDomains = /^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID ?? "") ? [`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`] : [];
  if (storageDomains.length && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(process.env.R2_BUCKET ?? "")) {
    storageDomains.push(`https://${process.env.R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  }
  const csp = { connectDomains: [...new Set([appOrigin, ...storageDomains, ...(options.connectDomains ?? []).map(origin)])], resourceDomains: [...new Set([appOrigin, ...storageDomains, ...(options.resourceDomains ?? []).map(origin)])], frameDomains: [] };
  for (const view of views) {
    const uri = `ui://narriflow/v2/${view}.html`;
    const resourceConfig = { cacheHint: { cacheScope: "public" as const, ttlMs: 86_400_000 }, _meta: { ui: { csp } } };
    registerAppResource(server, `narriflow-${view}-v2`, uri, resourceConfig, async () => {
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: narriflowAppHtml(view, appOrigin), _meta: { ui: { csp } } }] };
    });
  }
  if (options.callUpload) {
    const schemas = { open: openUploadSessionSchema, status: readUploadSessionSchema, grants: grantUploadPartsSchema, finalize: finalizeUploadSessionSchema, discard: discardUploadSessionSchema };
    for (const action of Object.keys(schemas) as NarriflowUploadAction[]) {
      const inputSchema = schemas[action].extend({ workspaceId: z.string().uuid() });
      registerAppTool(server, `narriflow_upload_${action}`, { description: "Upload Session transfer for the embedded picker", inputSchema, outputSchema: mcpAppTransferResultSchema, annotations: { readOnlyHint: action === "status", destructiveHint: action === "discard", idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: "ui://narriflow/v2/upload.html", visibility: ["app"] } } }, async (input: Record<string, unknown>, context: ServerContext) => {
        if (!supportsNarriflowApps(requestCapabilities(context, server), options.protocolEra)) throw new ProtocolError(-32602, "MCP Apps capability is required");
        return options.callUpload!(action, input);
      });
    }
  }
  if (options.acceptPublication) registerAppTool(server, "narriflow_accept_social_post_intent", { description: "Record the user's exact-post decision from the confirmation card", inputSchema: mcpAppConfirmIntentSchema, outputSchema: mcpAppConfirmationResultSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: "ui://narriflow/v2/publication-confirmation.html", visibility: ["app"] } } }, async (input, context) => {
    if (!supportsNarriflowApps(requestCapabilities(context, server), options.protocolEra)) throw new ProtocolError(-32602, "MCP Apps capability is required");
    return options.acceptPublication!(input);
  });
}
