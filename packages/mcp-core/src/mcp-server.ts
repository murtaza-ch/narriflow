import { ExecutionRegistrationPendingError } from "@narriflow/services/execution-dispatch-runtime";
import { McpServer, Server, type Implementation, type ServerOptions, type Transport, type JSONRPCRequest, type Result, type ServerContext, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

/** A new invocation for an actual RPC, independent of the HTTP stream lifetime. */
export type McpRequestScope = <T>(operation: () => Promise<T>) => Promise<T>;

const taskMethods = new Set(["tasks/get", "tasks/update", "tasks/cancel"]);
const internalTaskMethod = (method: string) => `narriflow-extension/${method}`;

/** SDK v2 reserves the old Tasks names and rejects them in its modern core
 * dispatcher. The public transport seam routes this extension into custom
 * handlers while preserving SDK envelope checks and response encoding. */
export class NarriflowTaskServer extends Server {
  constructor(identity: Implementation, options?: ServerOptions, private readonly requestScope?: McpRequestScope) {
    super(identity, options);
  }

  /** The SDK's documented registration hook covers tools, resources and Tasks,
   * including handlers installed by the SDK while connecting an exchange. */
  protected override _wrapHandler(method: string, handler: (request: JSONRPCRequest, context: ServerContext) => Promise<Result>) {
    const wrapped = super._wrapHandler(method, handler);
    return async (request: JSONRPCRequest, context: ServerContext) => {
      try { return this.requestScope ? await this.requestScope(() => wrapped(request, context)) : await wrapped(request, context); }
      catch (error) {
        if (error instanceof ExecutionRegistrationPendingError) throw new ProtocolError(ProtocolErrorCode.InternalError, error.message, {
          error: error.code, kind: "unavailable", retryable: true, retryAfterSeconds: error.retryAfterSeconds, receipt: error.receipt,
        });
        throw error;
      }
    };
  }

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
  constructor(identity: Implementation, options?: ServerOptions, requestScope?: McpRequestScope) {
    super(identity, options);
    this.server = new NarriflowTaskServer(identity, options, requestScope);
  }
}

