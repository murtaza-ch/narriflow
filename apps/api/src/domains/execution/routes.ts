import { EXECUTION_COMMAND_MAX_BYTES, executionCommandSchema, executionDispositionSchema,
  type ExecutionCommand, type ExecutionDisposition } from "@narriflow/validators/execution";
import { readBoundedBody } from "@narriflow/services/bounded-body";
import { ExecutorControlError } from "@narriflow/services/executor-control";
import { ExecutionStorageError } from "@narriflow/services/execution-storage";
import { executionTransferCommandSchema, executionTransferDispositionSchema,
  type ExecutionTransferCommand, type ExecutionTransferDisposition } from "@narriflow/validators/execution-transfer";
import type { Context } from "hono";
import { ExecutionSignatureError, verifyExecutionRequest, type VerifiedExecutionRequest } from "@narriflow/services/execution-signature";
import { createRouteApp } from "../../http/admission";
import { jsonError, markEnvelope, requestIdOf } from "../../http/errors";
import { executionAdmission } from "./admission";
import type { ApiWorkerBindings } from "../../worker-bindings";

export interface ExecutionRouteDependencies {
  keyRing(request?: Request, bindings?: ApiWorkerBindings): ReadonlyMap<string, Uint8Array> | Promise<ReadonlyMap<string, Uint8Array>>;
  audience?: "executor-control" | "dev-device";
  nowSeconds(): number;
  /** Construct database/domain work only after the signature and command have passed. */
  execute(command: ExecutionCommand, verifiedRequest: VerifiedExecutionRequest, bindings?: ApiWorkerBindings, request?: Request): Promise<ExecutionDisposition>;
  transfer(command: ExecutionTransferCommand, verifiedRequest: VerifiedExecutionRequest, bindings?: ApiWorkerBindings, request?: Request): Promise<ExecutionTransferDisposition>;
}

export class CommandTooLarge extends Error {}
export async function readCommandBody(request: Request, maxBytes = EXECUTION_COMMAND_MAX_BYTES) {
  if (Number(request.headers.get("Content-Length")) > maxBytes) throw new CommandTooLarge();
  const read = await readBoundedBody(request.body, maxBytes);
  if (read.kind === "too_large") throw new CommandTooLarge();
  return read.bytes;
}

export function executionCommandHandler(deps: ExecutionRouteDependencies, kind: "command" | "transfer") {
  return async (c: Context) => {
    const serverTime = () => new Date(deps.nowSeconds() * 1_000).toISOString();
    const refuse = (status: number, code: string, message: string) => markEnvelope(c, jsonError(status, code, message, requestIdOf(c), {
      "X-Execution-Server-Time": serverTime(),
    }));
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) return refuse(415, "unsupported_media_type", "Execution commands require JSON");
      const encoded = c.req.header("X-Execution-Signature");
      if (!encoded || encoded.length > 4096) return refuse(401, "execution_signature_invalid", "Execution signature is invalid");
      const body = await readCommandBody(c.req.raw);
      let signature: unknown;
      try { signature = JSON.parse(encoded); } catch { return refuse(401, "execution_signature_invalid", "Execution signature is invalid"); }
      const url = new URL(c.req.url);
      const verified = await verifyExecutionRequest({ signature, keyRing: await deps.keyRing(c.req.raw, c.env as ApiWorkerBindings), audience: deps.audience ?? "executor-control",
        method: c.req.method, target: url.pathname + url.search, body, nowSeconds: deps.nowSeconds() });
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { return refuse(400, "execution_command_invalid", "Execution command is invalid"); }
      const command = kind === "command" ? executionCommandSchema.safeParse(parsed) : executionTransferCommandSchema.safeParse(parsed);
      if (!command.success) return refuse(400, "execution_command_invalid", "Execution command is invalid");
      const disposition = kind === "command"
        ? executionDispositionSchema.parse(await deps.execute(command.data as ExecutionCommand, verified, c.env as ApiWorkerBindings, c.req.raw))
        : executionTransferDispositionSchema.parse(await deps.transfer(command.data as ExecutionTransferCommand, verified, c.env as ApiWorkerBindings, c.req.raw));
      c.header("X-Execution-Server-Time", serverTime());
      return c.json(disposition);
    } catch (error) {
      if (error instanceof CommandTooLarge) return refuse(413, "execution_command_too_large", "Execution command exceeds 64 KiB");
      if (error instanceof ExecutionSignatureError) return refuse(401, "execution_signature_invalid", "Execution signature is invalid");
      if (error instanceof ExecutionStorageError) {
        const unavailable = ["storage_configuration_invalid", "storage_provider_failed", "storage_completion_unconfirmed"].includes(error.code);
        return refuse(unavailable ? 503 : 409, error.code, "Execution transfer was refused");
      }
      if (error instanceof ExecutorControlError) {
        const status = error.code === "storage_unavailable" || error.code === "scheduler_unavailable" || error.code === "epoch_unavailable" || error.code === "keys_unavailable" ? 503
          : error.code === "artifact_invalid" ? 422 : 409;
        return refuse(status, error.code, "Execution command was refused");
      }
      throw error;
    }
  };
}
export function createExecutionRoutes(deps: ExecutionRouteDependencies) {
  return createRouteApp(executionAdmission)
    .post("/execution/command", executionCommandHandler(deps, "command"))
    .post("/execution/transfer", executionCommandHandler(deps, "transfer"));
}
