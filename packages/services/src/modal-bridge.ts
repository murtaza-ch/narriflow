import { modalBridgeCommandSchema, modalBridgeDispositionSchema, type ModalBridgeCommand, type ModalBridgeDisposition } from "@narriflow/validators/execution";
import { signExecutionRequest } from "./execution-signature";

const TARGET = "/bridge/command";
export class ModalBridgeError extends Error {
  constructor(readonly code: "modal_bridge_configuration_invalid" | "modal_bridge_unconfirmed" | "modal_bridge_refused") {
    super(code); this.name = "ModalBridgeError";
  }
}

/** Only the configured Modal origin. Arbitrary URLs use the guarded native executor. */
export function createModalBridgeClient(config: { origin: string; keyId: string; key: Uint8Array },
  options: { fetch?: typeof fetch; now?: () => Date } = {}) {
  let origin: URL;
  try { origin = new URL(config.origin); } catch { throw new ModalBridgeError("modal_bridge_configuration_invalid"); }
  if (origin.protocol !== "https:" || !/^[a-z0-9-]+\.modal\.run$/.test(origin.hostname) || origin.username || origin.password ||
    origin.port || origin.pathname !== "/" || origin.search || origin.hash || !/^[A-Za-z0-9_-]{1,64}$/.test(config.keyId) || !(config.key instanceof Uint8Array) || config.key.length < 32 || config.key.length > 64) {
    throw new ModalBridgeError("modal_bridge_configuration_invalid");
  }
  const key = new Uint8Array(config.key);
  const transport = options.fetch ?? fetch, now = options.now ?? (() => new Date());
  return {
    async command(input: ModalBridgeCommand, deliveryId: string): Promise<ModalBridgeDisposition> {
      const command = modalBridgeCommandSchema.parse(input);
      const body = new TextEncoder().encode(JSON.stringify(command));
      const metadata = await signExecutionRequest({ keyId: config.keyId, key, audience: "modal-bridge", method: "POST",
        target: TARGET, body, timestamp: Math.floor(now().getTime() / 1000), deliveryId });
      let response: Response;
      try {
        response = await transport(new URL(TARGET, origin), { method: "POST", headers: { "Content-Type": "application/json", "X-Execution-Signature": JSON.stringify(metadata) },
          body, signal: AbortSignal.timeout(15_000), redirect: "error" });
      } catch { throw new ModalBridgeError("modal_bridge_unconfirmed"); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModalBridgeError(response.status === 400 || response.status === 401 || response.status === 409 ? "modal_bridge_refused" : "modal_bridge_unconfirmed");
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
        await response.body?.cancel(); throw new ModalBridgeError("modal_bridge_unconfirmed");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ModalBridgeError("modal_bridge_unconfirmed");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 4096) { await reader.cancel(); throw new ModalBridgeError("modal_bridge_unconfirmed"); }
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const result = modalBridgeDispositionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if ((command.action === "spawn" && result.disposition !== "spawned") || (command.action === "status" && result.disposition !== "observed") ||
          (command.action === "cancel" && result.disposition !== "cancel_requested")) throw new ModalBridgeError("modal_bridge_unconfirmed");
        return result;
      } catch { throw new ModalBridgeError("modal_bridge_unconfirmed"); }
      finally { reader.releaseLock(); }
    },
  };
}
