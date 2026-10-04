import { CreateTaskResultV2Schema, GetTaskResultV2Schema, UpdateTaskRequestV2Schema, UpdateTaskResultV2Schema, CancelTaskResultV2Schema,
  hasTaskClientCapabilityV2, TASKS_EXTENSION_ID_V2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import { isInputRequiredResult, ProtocolError, ProtocolErrorCode, McpServer, Server, type Implementation, type ServerOptions,
  type Transport, type CallToolRequest, type CallToolResult, type ServerContext, type InputRequiredResult } from "@modelcontextprotocol/server";
import { clipExportService, createMcpTaskRegistry, getMcpTaskPersistence, getMcpTaskDomainState, cancelMcpTaskDomainWork, workspaceService,
  MCP_TASK_TTL_MS, MCP_TASK_POLL_INTERVAL_MS, ExpectedDomainFailureError, isExpectedDomainFailure,
  type McpTaskRecord, type McpTaskResolution } from "@narriflow/services";
import { mcpExportSchema, mcpOperationSchema, mcpResultSchema } from "@narriflow/validators";
import { z } from "zod";
import { mcpCallerId } from "./mcp-confirmation";
import { mcpExport } from "./mcp-projections";
import { McpToolAdmission, type NarriflowMcpPrincipal, type NarriflowMcpToolName } from "./mcp-tool-admission";

type Registry = ReturnType<typeof createMcpTaskRegistry>;
type TaskOptions = {
  principal: NarriflowMcpPrincipal;
  authenticatePrincipal?: () => Promise<NarriflowMcpPrincipal>;
  assertNewMutationAllowed?: (context: { tool: NarriflowMcpToolName; principal: NarriflowMcpPrincipal; workspaceId: string }) => void | Promise<void>;
  registry?: (principal: NarriflowMcpPrincipal) => Registry;
};
const operation = z.strictObject({ workspaceId: z.string().uuid(), domainKind: z.enum(["ingest", "generation", "export"]),
  domainId: z.string().uuid(), projectId: z.string().uuid(), clipId: z.string().uuid().optional() });
const taskParams = z.object({ taskId: z.string().uuid(), _meta: z.record(z.string(), z.unknown()).optional() }).strict();

const taskMethods = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);
const internalTaskMethod = (method: string) => `narriflow-extension/${method}`;

/** SDK v2 reserves the old Tasks names and rejects them in its modern core
 * dispatcher. The public transport seam routes this extension into custom
 * handlers while preserving SDK envelope checks and response encoding. */
class NarriflowTaskServer extends Server {
  override async connect(wire: Transport) {
    const server = this;
    const adapter: Transport = {
      get sessionId() { return wire.sessionId; },
      get hasPerRequestStream() { return wire.hasPerRequestStream; },
      async start() {
        wire.onclose = () => adapter.onclose?.();
        wire.onerror = (error) => adapter.onerror?.(error);
        wire.onmessage = (message, extra) => {
          if ("method" in message && message.method.startsWith("narriflow-extension/tasks/")) {
            // Aliases are an implementation detail, never an alternate public
            // route around the wire method/name validation.
            adapter.onmessage?.({ ...message, method: "narriflow-extension/unavailable" }, extra);
            return;
          }
          if ("method" in message && "id" in message && taskMethods.has(message.method) && server.getNegotiatedProtocolVersion() === "2026-07-28") {
            let params = message.params;
            if (message.method === "tasks/update") {
              // The core MRTR seam lifts inputResponses from every request.
              params = { ...params, taskInputResponses: params?.inputResponses };
              delete params.inputResponses;
            }
            adapter.onmessage?.({ ...message, method: internalTaskMethod(message.method), params }, extra);
          } else adapter.onmessage?.(message, extra);
        };
        await wire.start();
      },
      send: (message, options) => wire.send(message, options), close: () => wire.close(),
      setProtocolVersion: (version) => wire.setProtocolVersion?.(version),
      setSupportedProtocolVersions: (versions) => wire.setSupportedProtocolVersions?.(versions),
    };
    await super.connect(adapter);
  }
}

export class NarriflowMcpServer extends McpServer {
  override readonly server: Server;
  constructor(identity: Implementation, options?: ServerOptions) {
    super(identity, options);
    this.server = new NarriflowTaskServer(identity, options);
  }
}

export function mcpTaskTerminalResult(record: McpTaskRecord, status: "completed" | "failed", data?: unknown) {
  const initial = record.initialResult as CallToolResult;
  const structured = initial.structuredContent as { data: Record<string, unknown> };
  const finalData = data ?? { ...structured.data, status };
  const schema = record.domainKind === "export" ? mcpResultSchema(z.strictObject({ export: mcpExportSchema })) : mcpResultSchema(mcpOperationSchema);
  const validated = schema.parse({ data: finalData });
  // The SDK does not stamp cache fields on nested eventual ToolResults.
  return { resultType: "complete", ttlMs: 0, cacheScope: "private", content: [{ type: "text", text: JSON.stringify(validated.data) }], structuredContent: validated,
    ...(status === "failed" ? { isError: true } : {}) };
}

function productionRegistry(principal: NarriflowMcpPrincipal, options: TaskOptions): Registry {
  const admission = new McpToolAdmission(workspaceService);
  const scope = (record: McpTaskRecord) => ({ actorUserId: principal.userId, workspaceId: record.workspaceId });
  return createMcpTaskRegistry({ persistence: getMcpTaskPersistence(),
    authorize: async (record) => {
      await admission.requireWorkspace(record.domainKind === "export" ? "narriflow_get_clip_export" : "narriflow_get_project", principal, record.workspaceId);
      if (!await getMcpTaskDomainState(record)) throw new ExpectedDomainFailureError({ code: "mcp_task_not_found", kind: "missing", message: "Task operation is unavailable" });
    },
    resolve: async (record): Promise<McpTaskResolution> => {
      const state = await getMcpTaskDomainState(record);
      if (!state) return { status: "failed", error: { code: -32003, message: "Operation is unavailable" } };
      if (state.cancelled) return { status: "cancelled" };
      if (record.domainKind === "export") {
        if (!["ready", "partial_ready", "failed"].includes(state.status)) return { status: "working" };
        const snapshot = await clipExportService.getWorkspaceOwned(scope(record), record.domainId);
        if (!snapshot) return { status: "failed", error: { code: -32003, message: "Export is unavailable" } };
        return { status: "completed", result: mcpTaskTerminalResult(record, snapshot.status === "failed" ? "failed" : "completed",
          { export: mcpExport(snapshot, new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").origin) }) };
      }
      if (["completed", "partial", "failed"].includes(state.status)) return { status: "completed", result: mcpTaskTerminalResult(record, state.status === "failed" ? "failed" : "completed") };
      return { status: "working" };
    },
    beforeCancel: async (record) => {
      const tool = record.domainKind === "export" ? "narriflow_create_clip_export" : "narriflow_generate_clips";
      await admission.requireWorkspace(tool, principal, record.workspaceId);
      if (!record.cancellationRequestedAt) await options.assertNewMutationAllowed?.({ tool, principal, workspaceId: record.workspaceId });
    },
    cancel: async (record) => {
      await cancelMcpTaskDomainWork(record);
    },
  });
}

function negotiated(context: ServerContext) {
  return (context.mcpReq.envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28" &&
    hasTaskClientCapabilityV2({ _meta: context.mcpReq.envelope });
}
function wireTask(record: McpTaskRecord) {
  return { taskId: record.id, status: record.status, createdAt: record.createdAt.toISOString(), lastUpdatedAt: record.updatedAt.toISOString(),
    ttlMs: MCP_TASK_TTL_MS, pollIntervalMs: MCP_TASK_POLL_INTERVAL_MS };
}
function taskError(error: unknown): never {
  if (error instanceof ProtocolError) throw error;
  throw new ProtocolError(isExpectedDomainFailure(error) && error.kind === "missing" ? ProtocolErrorCode.InvalidParams : -32002,
    isExpectedDomainFailure(error) ? error.message : "Task operation is temporarily unavailable",
    isExpectedDomainFailure(error) ? { error: error.code, kind: error.kind, retryAfterSeconds: error.retryAfterSeconds } : { retryAfterSeconds: 5 });
}

/** Wrap the public registration seam before McpServer installs tools/call.
 * The original handler validates final tool results; this dispatcher validates
 * task handles separately before returning through the SDK's modern wire codec. */
export function installNarriflowTasks(server: McpServer, options: TaskOptions) {
  const protocol = server.server;
  if (!(protocol instanceof NarriflowTaskServer)) throw new Error("Narriflow Tasks requires its extension-aware server factory");
  const principal = options.authenticatePrincipal ?? (async () => options.principal);
  const registry = (current: NarriflowMcpPrincipal) => options.registry?.(current) ?? productionRegistry(current, options);
  protocol.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID_V2]: {} } });
  const originalCapabilities = protocol.getCapabilities.bind(protocol);
  protocol.getCapabilities = () => {
    const caps = originalCapabilities();
    const enabled = protocol.getNegotiatedProtocolVersion() === "2026-07-28" &&
      hasTaskClientCapabilityV2({ _meta: { "io.modelcontextprotocol/clientCapabilities": protocol.getClientCapabilities() } });
    if (enabled) return caps;
    const extensions = { ...caps.extensions }; delete extensions[TASKS_EXTENSION_ID_V2];
    return { ...caps, extensions };
  };
  const originalSet = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = ((method: string, schemasOrHandler: unknown, handler?: unknown) => {
    if (method === "tools/call" && typeof schemasOrHandler === "function" && !handler) {
      const original = schemasOrHandler as (request: CallToolRequest, context: ServerContext) => Promise<CallToolResult | InputRequiredResult>;
      originalSet("tools/call", async (request, context) => {
        const result = await original(request, context);
        if (isInputRequiredResult(result) || result.isError || !negotiated(context)) return result;
        const reference = operation.safeParse(result._meta?.["narriflow/operation"]);
        if (!reference.success) return result;
        try {
          const current = await principal();
          const record = await registry(current).register({ ownerUserId: current.userId, callerId: mcpCallerId(current),
            workspaceId: reference.data.workspaceId, toolName: request.params.name, domainKind: reference.data.domainKind,
            domainId: reference.data.domainId, projectId: reference.data.projectId, clipId: reference.data.clipId ?? null,
            originatingOperationId: String(request.params.arguments?.clientIdempotencyKey ?? reference.data.domainId),
            resultContract: { version: 1, toolName: request.params.name },
            initialResult: { content: result.content, structuredContent: result.structuredContent },
          });
          return { ...CreateTaskResultV2Schema.parse({ ...wireTask(record), resultType: "task",
            _meta: { "narriflow/operation": reference.data } }), content: [] };
        } catch (error) {
          // Task retention must not shorten the owning operation's replay life.
          if (isExpectedDomainFailure(error) && error.code === "mcp_task_expired") return result;
          taskError(error);
        }
      });
    } else if (typeof schemasOrHandler === "function") {
      // Forward spec registrations without accessing SDK private handler maps.
      Reflect.apply(originalSet, protocol, [method, schemasOrHandler]);
    } else Reflect.apply(originalSet, protocol, [method, schemasOrHandler, handler]);
  }) as typeof protocol.setRequestHandler;

  async function dispatch<T>(context: ServerContext, run: (owned: Registry, owner: { ownerUserId: string; callerId: string }) => Promise<T>) {
    if (!negotiated(context)) throw new ProtocolError(ProtocolErrorCode.MethodNotFound, "Tasks extension was not negotiated");
    try { const current = await principal(); return await run(registry(current), { ownerUserId: current.userId, callerId: mcpCallerId(current) }); }
    catch (error) { taskError(error); }
  }
  protocol.setRequestHandler(internalTaskMethod("tasks/get"), { params: taskParams, result: GetTaskResultV2Schema }, async (params, context) =>
    dispatch(context, async (owned, owner) => {
      const record = await owned.get(params.taskId, owner);
      const outcome = record.terminalOutcome as McpTaskResolution | null;
      return GetTaskResultV2Schema.parse({ ...wireTask(record), resultType: "complete", ...(outcome?.status === "completed" ? { result: outcome.result } : {}),
        ...(outcome?.status === "failed" ? { error: outcome.error } : {}) });
    }));
  protocol.setRequestHandler(internalTaskMethod("tasks/update"), { params: taskParams.extend({ taskInputResponses: UpdateTaskRequestV2Schema.shape.params.shape.inputResponses }), result: UpdateTaskResultV2Schema },
    async (params, context) => dispatch(context, async (owned, owner) => { await owned.update(params.taskId, owner); return UpdateTaskResultV2Schema.parse({ resultType: "complete" }); }));
  protocol.setRequestHandler(internalTaskMethod("tasks/cancel"), { params: taskParams, result: CancelTaskResultV2Schema }, async (params, context) =>
    dispatch(context, async (owned, owner) => { await owned.cancel(params.taskId, owner); return CancelTaskResultV2Schema.parse({ resultType: "complete" }); }));
}
