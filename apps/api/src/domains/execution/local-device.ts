import { createLocalFetchDeviceCodec, requireLocalFetchDevelopment, type LocalFetchDeviceClaims } from "@narriflow/services/local-fetch-device";
import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { ExecutorControlError } from "@narriflow/services/executor-control";
import { ExecutionSignatureError, verifyExecutionRequest } from "@narriflow/services/execution-signature";
import { createRouteApp } from "../../http/admission";
import { jsonError, requestIdOf } from "../../http/errors";
import { executionKeyRing } from "../../execution-keys";
import type { ApiWorkerBindings } from "../../worker-bindings";
import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import type { AdmissionTable } from "../platform/admission-table";
import { CommandTooLarge, readCommandBody, executionCommandHandler, type ExecutionRouteDependencies } from "./routes";
import { createWorkerExecutor } from "./runtime";
import { localDeviceMailbox } from "../../resource-ports";
import { getLocalFetchDeviceExecution } from "./local-device-runtime";

export const localDeviceAdmission = {
  "POST /dev-device/connect-ticket": { trust: "dev_device_signature" },
  "POST /dev-device/reconcile": { trust: "dev_device_signature" },
  "POST /dev-device/execution/command": { trust: "dev_device_signature" },
  "POST /dev-device/execution/transfer": { trust: "dev_device_signature" },
  "GET /dev-device/:workspaceId/socket": { trust: "dev_device_signature" },
} as const satisfies AdmissionTable;

function codec() { return createLocalFetchDeviceCodec(executionKeyRing(readServiceEnvironment().DEV_DEVICE_KEYS_JSON)); }

async function authenticate(request: Request | undefined, bindings: ApiWorkerBindings | undefined) {
  try {
    if (!request || !(bindings?.LOCAL_FETCH_MAILBOX || bindings?.DEV_CLOUD)) throw new Error();
    const token = request.headers.get("X-Local-Fetch-Session") ?? "";
    const verified = await codec().verify(token);
    requireLocalFetchDevelopment(readServiceEnvironment(), verified.claims.workspaceId);
    if (verified.claims.apiOrigin !== readServiceEnvironment().API_ORIGIN) throw new Error();
    const current = await localDeviceMailbox(bindings, verified.claims.workspaceId).authorize(verified.claims.sessionId);
    if (JSON.stringify(current) !== JSON.stringify(verified.claims)) throw new Error();
    return verified;
  } catch { throw new ExecutionSignatureError("invalid_metadata"); }
}

export function createLocalDeviceExecutionDependencies(): ExecutionRouteDependencies {
  const authenticated = new WeakMap<Request, LocalFetchDeviceClaims>();
  async function reference(request: Request | undefined, value: ExecutionDispatchReference, bindings: ApiWorkerBindings) {
    const claims = request && authenticated.get(request);
    if (!claims) throw new ExecutorControlError("invalid_reference");
    await getLocalFetchDeviceExecution(bindings).authorizeReference(claims, value);
  }
  return {
    audience: "dev-device", nowSeconds: () => Math.floor(Date.now() / 1000),
    async keyRing(request, bindings) {
      const verified = await authenticate(request, bindings);
      authenticated.set(request!, verified.claims);
      return new Map([[verified.claims.sessionId, verified.key]]);
    },
    async execute(command, verified, bindings, request) {
      const value = command.action === "acquire" ? command.reference : command.fence.reference;
      await reference(request, value, bindings!);
      return (await createWorkerExecutor(value, bindings)).control.execute({ command, verifiedRequest: verified });
    },
    async transfer(command, verified, bindings, request) {
      await reference(request, command.fence.reference, bindings!);
      return (await createWorkerExecutor(command.fence.reference, bindings)).transfer.execute({ command, verifiedRequest: verified });
    },
  };
}

/** No PostgreSQL work is reachable before the scoped device signature passes. */
export function createLocalDeviceRoutes() {
  const execution = createLocalDeviceExecutionDependencies();
  const signed = (action: "connect-ticket" | "reconcile") => async (c: import("hono").Context) => {
    try {
      const auth = await authenticate(c.req.raw, c.env as ApiWorkerBindings);
      // Device requests here contain only an optional UUID cursor, never media.
      const body = await readCommandBody(c.req.raw, 256);
      const signature = JSON.parse(c.req.header("X-Execution-Signature") ?? "null");
      await verifyExecutionRequest({ signature, keyRing: new Map([[auth.claims.sessionId, auth.key]]), audience: "dev-device", method: "POST",
        target: new URL(c.req.url).pathname + new URL(c.req.url).search, body, nowSeconds: Math.floor(Date.now() / 1000) });
      c.header("Cache-Control", "no-store");
      if (action === "connect-ticket") return c.json(await localDeviceMailbox(c.env as ApiWorkerBindings, auth.claims.workspaceId).connectTicket(auth.claims.sessionId));
      const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as { after?: unknown };
      if (!input || typeof input !== "object" || Object.keys(input).some(key => key !== "after") || input.after !== undefined && (typeof input.after !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.after))) return c.body(null, 400);
      return c.json(await getLocalFetchDeviceExecution(c.env as ApiWorkerBindings).reconcile(auth.claims, input.after as string | undefined));
    } catch (error) {
      if (error instanceof ExecutionSignatureError) return jsonError(401, "local_fetch_session_invalid", "Device authentication failed", requestIdOf(c));
      if (error instanceof CommandTooLarge) return c.body(null, 413);
      if (error instanceof SyntaxError) return c.body(null, 400);
      throw error;
    }
  };
  return createRouteApp(localDeviceAdmission)
    .post("/dev-device/connect-ticket", signed("connect-ticket"))
    .post("/dev-device/reconcile", signed("reconcile"))
    .post("/dev-device/execution/command", executionCommandHandler(execution, "command"))
    .post("/dev-device/execution/transfer", executionCommandHandler(execution, "transfer"))
    .get("/dev-device/:workspaceId/socket", c => {
      try { requireLocalFetchDevelopment(readServiceEnvironment(), c.req.param("workspaceId")); }
      catch { return c.body(null, 403); }
      const remote = (c.env as ApiWorkerBindings).DEV_CLOUD;
      if (remote) return remote.fetch(c.req.raw);
      return (c.env as ApiWorkerBindings).LOCAL_FETCH_MAILBOX.getByName(c.req.param("workspaceId")).fetch(c.req.raw);
    });
}
