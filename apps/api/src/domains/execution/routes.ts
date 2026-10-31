import { EXECUTION_COMMAND_MAX_BYTES, executionCommandSchema, executionDispositionSchema,
  type ExecutionCommand, type ExecutionDisposition } from "@narriflow/validators/execution";
import { ExecutorControlError } from "@narriflow/services/executor-control";
import { ExecutionSignatureError, verifyExecutionRequest, type VerifiedExecutionRequest } from "@narriflow/services/execution-signature";
import { createRouteApp } from "../../http/admission";
import { jsonError, markEnvelope, requestIdOf } from "../../http/errors";
import { executionAdmission } from "./admission";

export interface ExecutionRouteDependencies {
  keyRing(): ReadonlyMap<string, Uint8Array>;
  nowSeconds(): number;
  /** Construct database/domain work only after the signature and command have passed. */
  execute(command: ExecutionCommand, verifiedRequest: VerifiedExecutionRequest): Promise<ExecutionDisposition>;
}

class CommandTooLarge extends Error {}
async function readCommandBody(request: Request) {
  if (Number(request.headers.get("Content-Length")) > EXECUTION_COMMAND_MAX_BYTES) throw new CommandTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > EXECUTION_COMMAND_MAX_BYTES) { await reader.cancel(); throw new CommandTooLarge(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function createExecutionRoutes(deps: ExecutionRouteDependencies) {
  return createRouteApp(executionAdmission).post("/execution/command", async c => {
    const refuse = (status: number, code: string, message: string) => markEnvelope(c, jsonError(status, code, message, requestIdOf(c)));
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) return refuse(415, "unsupported_media_type", "Execution commands require JSON");
      const encoded = c.req.header("X-Execution-Signature");
      if (!encoded || encoded.length > 4096) return refuse(401, "execution_signature_invalid", "Execution signature is invalid");
      const body = await readCommandBody(c.req.raw);
      let signature: unknown;
      try { signature = JSON.parse(encoded); } catch { return refuse(401, "execution_signature_invalid", "Execution signature is invalid"); }
      const url = new URL(c.req.url);
      const verified = await verifyExecutionRequest({ signature, keyRing: deps.keyRing(), audience: "executor-control",
        method: c.req.method, target: url.pathname + url.search, body, nowSeconds: deps.nowSeconds() });
      let command: ExecutionCommand;
      try { command = executionCommandSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))); }
      catch { return refuse(400, "execution_command_invalid", "Execution command is invalid"); }
      const disposition = executionDispositionSchema.parse(await deps.execute(command, verified));
      return c.json(disposition);
    } catch (error) {
      if (error instanceof CommandTooLarge) return refuse(413, "execution_command_too_large", "Execution command exceeds 64 KiB");
      if (error instanceof ExecutionSignatureError) return refuse(401, "execution_signature_invalid", "Execution signature is invalid");
      if (error instanceof ExecutorControlError) {
        const status = error.code === "storage_unavailable" || error.code === "scheduler_unavailable" || error.code === "epoch_unavailable" || error.code === "keys_unavailable" ? 503
          : error.code === "artifact_invalid" ? 422 : 409;
        return refuse(status, error.code, "Execution command was refused");
      }
      throw error;
    }
  });
}
