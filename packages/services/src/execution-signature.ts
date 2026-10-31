import {
  EXECUTION_COMMAND_MAX_BYTES,
  EXECUTION_SIGNATURE_MAX_AGE_SECONDS,
  executionSignatureSchema,
  type ExecutionSignature,
} from "@narriflow/validators/execution";

export type ExecutionSignatureFailureCode =
  | "invalid_metadata"
  | "invalid_target"
  | "invalid_key"
  | "invalid_clock"
  | "body_too_large"
  | "method_mismatch"
  | "target_mismatch"
  | "body_mismatch"
  | "wrong_audience"
  | "expired"
  | "signature_mismatch";

export class ExecutionSignatureError extends Error {
  constructor(readonly code: ExecutionSignatureFailureCode) {
    super(code);
    this.name = "ExecutionSignatureError";
  }
}

const encoder = new TextEncoder();

function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Origin-form only. Paths are validated before any URL parser can normalize them. */
export function canonicalExecutionTarget(target: string): string {
  try {
    if (typeof target !== "string" || target.length > 2048 ||
      !target.startsWith("/") || /[^\x21-\x7e]|[#\\]/.test(target)) {
      throw new ExecutionSignatureError("invalid_target");
    }
    const separator = target.indexOf("?");
    const path = separator < 0 ? target : target.slice(0, separator);
    if (path.includes("//")) throw new ExecutionSignatureError("invalid_target");
    for (const segment of path.slice(1).split("/")) {
      const decoded = decodeURIComponent(segment);
      if (decoded === "." || decoded === ".." || /[/%\\?#]/.test(decoded) ||
        Array.from(decoded).some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) ||
        encodeComponent(decoded) !== segment) {
        throw new ExecutionSignatureError("invalid_target");
      }
    }
    const pairs: Array<[string, string]> = [];
    if (separator >= 0) {
      for (const entry of target.slice(separator + 1).split("&")) {
        if (!entry) continue;
        const equals = entry.indexOf("=");
        const name = equals < 0 ? entry : entry.slice(0, equals);
        const value = equals < 0 ? "" : entry.slice(equals + 1);
        pairs.push([decodeURIComponent(name.replace(/\+/g, " ")), decodeURIComponent(value.replace(/\+/g, " "))]);
      }
    }
    pairs.sort(([aName, aValue], [bName, bValue]) => compareUtf8(aName, bName) || compareUtf8(aValue, bValue));
    const query = pairs.map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`).join("&");
    const canonical = `${path}${query ? `?${query}` : ""}`;
    if (canonical.length > 2048) throw new ExecutionSignatureError("invalid_target");
    return canonical;
  } catch (error) {
    if (error instanceof ExecutionSignatureError) throw error;
    throw new ExecutionSignatureError("invalid_target");
  }
}

export type ExecutionAudience = ExecutionSignature["audience"];
export type ExecutionMethod = ExecutionSignature["method"];

export interface SignExecutionRequestInput {
  keyId: string;
  key: Uint8Array;
  audience: ExecutionAudience;
  method: ExecutionMethod;
  target: string;
  body: Uint8Array;
  timestamp: number;
  deliveryId: string;
}

function checkedKey(key: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(key instanceof Uint8Array) || key.length < 32 || key.length > 64) {
    throw new ExecutionSignatureError("invalid_key");
  }
  return new Uint8Array(key);
}

function checkedBody(body: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(body instanceof Uint8Array)) throw new ExecutionSignatureError("invalid_metadata");
  if (body.byteLength > EXECUTION_COMMAND_MAX_BYTES) throw new ExecutionSignatureError("body_too_large");
  return new Uint8Array(body);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function signatureMessage(metadata: ExecutionSignature): Uint8Array<ArrayBuffer> {
  return encoder.encode([
    metadata.version, metadata.keyId, metadata.audience, metadata.method,
    metadata.canonicalTarget, metadata.bodySha256, metadata.timestamp, metadata.deliveryId,
  ].join("\n"));
}

function parseMetadata(value: unknown): ExecutionSignature {
  const result = executionSignatureSchema.safeParse(value);
  if (!result.success) throw new ExecutionSignatureError("invalid_metadata");
  return result.data;
}

export async function signExecutionRequest(input: SignExecutionRequestInput): Promise<ExecutionSignature> {
  const keyBytes = checkedKey(input.key);
  const bodyBytes = checkedBody(input.body);
  const canonicalTarget = canonicalExecutionTarget(input.target);
  const metadata = parseMetadata({
    version: 1,
    keyId: input.keyId,
    audience: input.audience,
    method: input.method,
    canonicalTarget,
    bodySha256: await sha256(bodyBytes),
    timestamp: input.timestamp,
    deliveryId: input.deliveryId,
    signature: "0".repeat(64),
  });
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { ...metadata, signature: hex(await crypto.subtle.sign("HMAC", key, signatureMessage(metadata))) };
}

export interface VerifyExecutionRequestInput {
  signature: unknown;
  keyRing: ReadonlyMap<string, Uint8Array>;
  audience: ExecutionAudience;
  method: string;
  target: string;
  body: Uint8Array;
  nowSeconds: number;
}

export interface VerifiedExecutionRequest {
  metadata: ExecutionSignature;
  /** Identifies the entire signed request for durable inbox conflict checks. */
  requestHash: string;
}

/** Verifies transport identity only; domain fencing and durable replay remain mandatory. */
export async function verifyExecutionRequest(input: VerifyExecutionRequestInput): Promise<VerifiedExecutionRequest> {
  const bodyBytes = checkedBody(input.body);
  const metadata = parseMetadata(input.signature);
  if (!Number.isSafeInteger(input.nowSeconds) || input.nowSeconds <= 0) {
    throw new ExecutionSignatureError("invalid_clock");
  }
  if (Math.abs(input.nowSeconds - metadata.timestamp) > EXECUTION_SIGNATURE_MAX_AGE_SECONDS) {
    throw new ExecutionSignatureError("expired");
  }
  if (metadata.audience !== input.audience) throw new ExecutionSignatureError("wrong_audience");
  if (metadata.method !== input.method) throw new ExecutionSignatureError("method_mismatch");
  const target = canonicalExecutionTarget(input.target);
  if (canonicalExecutionTarget(metadata.canonicalTarget) !== metadata.canonicalTarget || metadata.canonicalTarget !== target) {
    throw new ExecutionSignatureError("target_mismatch");
  }
  const configuredKey = input.keyRing.get(metadata.keyId);
  if (!configuredKey) throw new ExecutionSignatureError("invalid_key");
  const keyBytes = checkedKey(configuredKey);
  if (metadata.bodySha256 !== await sha256(bodyBytes)) throw new ExecutionSignatureError("body_mismatch");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(metadata.signature.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const message = signatureMessage(metadata);
  if (!await crypto.subtle.verify("HMAC", key, signature, message)) throw new ExecutionSignatureError("signature_mismatch");
  return { metadata, requestHash: await sha256(message) };
}
