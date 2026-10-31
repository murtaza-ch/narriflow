import { ExecutorControlError } from "@narriflow/services/executor-control";

export function executionKeyRing(raw: string | undefined): ReadonlyMap<string, Uint8Array> {
  if (!raw || raw.length > 8192) throw new ExecutorControlError("keys_unavailable");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ExecutorControlError("keys_unavailable"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExecutorControlError("keys_unavailable");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 8) throw new ExecutorControlError("keys_unavailable");
  const ring = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new ExecutorControlError("keys_unavailable");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 32 || bytes.length > 64 || bytes.toString("base64") !== encoded) throw new ExecutorControlError("keys_unavailable");
    ring.set(keyId, bytes);
  }
  return ring;
}

