import { registerAppResource, registerAppTool, getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { type McpServer, type CallToolResult, type ClientCapabilities, type ServerContext, ProtocolError } from "@modelcontextprotocol/server";
import { openUploadSessionSchema, readUploadSessionSchema, grantUploadPartsSchema, finalizeUploadSessionSchema, discardUploadSessionSchema, mcpAppTransferResultSchema, mcpAppConfirmationResultSchema, mcpAppConfirmIntentSchema } from "@narriflow/validators";
import { z } from "zod";
import { narriflowAppScript } from "./mcp-apps/v1/app-script";

export type NarriflowAppView = "upload" | "progress" | "clip-review" | "publication-confirmation";
export type NarriflowUploadAction = "open" | "status" | "grants" | "finalize" | "discard";
const views: NarriflowAppView[] = ["upload", "progress", "clip-review", "publication-confirmation"];

export function getNarriflowAppToolMeta(view: NarriflowAppView) {
  return { ui: { resourceUri: `ui://narriflow/v1/${view}.html`, visibility: ["model", "app"] as Array<"model" | "app"> } };
}
export function supportsNarriflowApps(capabilities?: ClientCapabilities | null) {
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) === true;
}

export interface NarriflowMcpAppsOptions {
  appOrigin: string;
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
function html(view: NarriflowAppView, appOrigin: string) {
  const titles = { upload: "Upload a video", progress: "Processing progress", "clip-review": "Review this clip", "publication-confirmation": "Confirm this exact post" };
  const actions = { upload: "Upload and generate clips", progress: "Refresh progress", "clip-review": "Open clip in Narriflow", "publication-confirmation": "Confirm and schedule" };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titles[view]}</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:20px;color:var(--color-text-primary,#17202a);background:var(--color-background-primary,#fff)}h1{font-size:20px;margin:0 0 8px}p{overflow-wrap:anywhere}#details p{margin:6px 0}button{font:inherit;padding:9px 14px;border:1px solid #87919e;border-radius:6px;background:transparent;color:inherit;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #547ade;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}progress{width:100%;margin-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}input{max-width:100%}</style></head><body data-view="${view}" data-app-origin="${appOrigin}"><h1>${titles[view]}</h1><p id="status" role="status" aria-live="polite">Connecting to Narriflow…</p><div id="details"></div><label${view === "upload" ? "" : " hidden"}>Video or audio file <input id="file" type="file" accept="video/*,audio/*"></label><progress id="progress" hidden value="0"></progress><div class="actions"><button id="action" disabled>${actions[view]}</button><button id="secondary" disabled>${view === "publication-confirmation" ? "Decline" : "Open Narriflow"}</button></div><script type="module">${narriflowAppScript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

/** Resources are immutable templates. Private tool outcomes are delivered by the
 * host bridge and must use private, zero-TTL caching in the server factory. */
export function registerNarriflowMcpApps(server: McpServer, options: NarriflowMcpAppsOptions) {
  const appOrigin = origin(options.appOrigin);
  const storageDomains = /^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID ?? "") ? [`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`] : [];
  const csp = { connectDomains: [...new Set([appOrigin, ...storageDomains, ...(options.connectDomains ?? []).map(origin)])], resourceDomains: [...new Set([appOrigin, ...storageDomains, ...(options.resourceDomains ?? []).map(origin)])], frameDomains: [] };
  for (const view of views) {
    const uri = `ui://narriflow/v1/${view}.html`;
    const resourceConfig = { cacheHint: { cacheScope: "public" as const, ttlMs: 86_400_000 }, _meta: { ui: { csp } } };
    registerAppResource(server, `narriflow-${view}-v1`, uri, resourceConfig, async (_url, context) => {
      if (!supportsNarriflowApps(requestCapabilities(context, server))) throw new ProtocolError(-32602, "MCP Apps capability is required");
      return { contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html(view, appOrigin), _meta: { ui: { csp } } }] };
    });
  }
  if (options.callUpload) {
    const schemas = { open: openUploadSessionSchema, status: readUploadSessionSchema, grants: grantUploadPartsSchema, finalize: finalizeUploadSessionSchema, discard: discardUploadSessionSchema };
    for (const action of Object.keys(schemas) as NarriflowUploadAction[]) {
      const inputSchema = schemas[action].extend({ workspaceId: z.string().uuid() });
      registerAppTool(server, `narriflow_upload_${action}`, { description: "Upload Session transfer for the embedded picker", inputSchema, outputSchema: mcpAppTransferResultSchema, annotations: { readOnlyHint: action === "status", destructiveHint: action === "discard", idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: "ui://narriflow/v1/upload.html", visibility: ["app"] } } }, async (input: Record<string, unknown>, context: ServerContext) => {
        if (!supportsNarriflowApps(requestCapabilities(context, server))) throw new ProtocolError(-32602, "MCP Apps capability is required");
        return options.callUpload!(action, input);
      });
    }
  }
  if (options.acceptPublication) registerAppTool(server, "narriflow_accept_social_post_intent", { description: "Record the user's exact-post decision from the confirmation card", inputSchema: mcpAppConfirmIntentSchema, outputSchema: mcpAppConfirmationResultSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: "ui://narriflow/v1/publication-confirmation.html", visibility: ["app"] } } }, async (input, context) => {
    if (!supportsNarriflowApps(requestCapabilities(context, server))) throw new ProtocolError(-32602, "MCP Apps capability is required");
    return options.acceptPublication!(input);
  });
}
