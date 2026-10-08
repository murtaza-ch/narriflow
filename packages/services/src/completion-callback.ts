import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { ExpectedDomainFailureError } from "./expected-domain-failure";
import type { OperationKind, TrustedOperationStatus } from "./operation-status";
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  guardedFetch,
  type HostResolver,
  type PinnedTransport,
} from "./url-guard";

/**
 * Completion Callback: a signed, at-least-once notification delivered to a
 * caller-supplied URL when one accepted operation reaches a terminal
 * Operation Status. Payloads carry IDs only; receivers call the API for files.
 * Signing follows Standard Webhooks (https://www.standardwebhooks.com/).
 */

export const CALLBACK_DELIVERY_TIMEOUT_MS = 10_000;
/** Retries after the first attempt; the row fails after the last one. */
export const CALLBACK_RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
] as const;
export const CALLBACK_RETRY_JITTER = 0.2;
const OBSERVATION_FIRST_DELAY_MS = 15_000;
const OBSERVATION_MAX_DELAY_MS = 300_000;
/** After rotation the previous secret keeps signing for this long. */
export const CALLBACK_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;
const MAX_CALLBACK_URL_LENGTH = 2_048;

export type CallbackState = "waiting" | "pending" | "delivered" | "failed" | "cancelled";

function invalidUrl(reason: string): never {
  throw new ExpectedDomainFailureError({
    code: "callback_url_invalid",
    kind: "invalid",
    message: "Callback URLs must be public HTTPS URLs on port 443",
    details: { reason },
  });
}

/** Acceptance check: HTTPS on the default port, public host, public DNS. */
export async function assertCompletionCallbackUrl(raw: string, resolver?: HostResolver): Promise<URL> {
  if (raw.length > MAX_CALLBACK_URL_LENGTH) invalidUrl("too_long");
  let url: URL;
  try {
    url = assertPublicHttpUrl(raw);
  } catch {
    invalidUrl("not_public");
  }
  if (url.protocol !== "https:") invalidUrl("not_https");
  if (url.port !== "") invalidUrl("not_port_443");
  try {
    await assertPublicHttpUrlResolved(url, resolver);
  } catch {
    invalidUrl("not_public");
  }
  return url;
}

function callbackKey(material: string) {
  if (!material.trim()) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY is required for Completion Callbacks");
  return Buffer.from(hkdfSync("sha256", material, Buffer.alloc(0), "narriflow-completion-callback-v1", 32));
}

/** Seals callback URLs and signing secrets with a purpose-bound key derived
 * from the existing data encryption key material. */
export function createCallbackCipher(material = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ?? "") {
  const key = callbackKey(material);
  return {
    seal(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
    },
    open(sealed: string) {
      const [version, iv, tag, ciphertext] = sealed.split(":");
      if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported sealed callback value");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

export type CallbackCipher = ReturnType<typeof createCallbackCipher>;

/** What a callback row stores about its URL. The fingerprint compares
 * replayed URLs without decrypting. */
export interface CallbackRegistration {
  encryptedUrl: string;
  urlHost: string;
  urlFingerprint: string;
}

export function callbackUrlFingerprint(url: string) {
  return createHash("sha256").update(url).digest("hex");
}

export function prepareCallbackRegistration(url: URL, cipher: CallbackCipher = createCallbackCipher()): CallbackRegistration {
  const href = url.toString();
  return { encryptedUrl: cipher.seal(href), urlHost: url.host, urlFingerprint: callbackUrlFingerprint(href) };
}

export function generateCallbackSigningSecret() {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/** Standard Webhooks signature header: one `v1,<base64>` per valid secret. */
export function signCallback(input: { eventId: string; timestamp: number; body: string; secrets: readonly string[] }) {
  return input.secrets
    .map((secret) => {
      const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
      return `v1,${createHmac("sha256", key).update(`${input.eventId}.${input.timestamp}.${input.body}`).digest("base64")}`;
    })
    .join(" ");
}

const OPERATION_KIND_CODES: Record<OperationKind, number> = { intake: 1, generation: 2, export: 3 };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public operation IDs are opaque: they encode kind and domain ID, and every
 * read decodes them server-side and rechecks Workspace access. */
export function encodeOperationId(operation: { kind: OperationKind; id: string }) {
  return `op_${Buffer.concat([Buffer.from([OPERATION_KIND_CODES[operation.kind]]), Buffer.from(operation.id.replaceAll("-", ""), "hex")]).toString("base64url")}`;
}

export function decodeOperationId(value: string): { kind: OperationKind; id: string } | null {
  if (!/^op_[A-Za-z0-9_-]{23}$/.test(value)) return null;
  const bytes = Buffer.from(value.slice(3), "base64url");
  const kind = (Object.entries(OPERATION_KIND_CODES).find(([, code]) => code === bytes[0])?.[0] ?? null) as OperationKind | null;
  if (!kind || bytes.length !== 17) return null;
  const hex = bytes.subarray(1).toString("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_PATTERN.test(id) ? { kind, id } : null;
}

export interface CallbackPayload {
  id: string;
  type: "operation.completed";
  version: 1;
  createdAt: string;
  workspaceId: string;
  data: {
    operationId: string;
    kind: OperationKind;
    state: "completed" | "partial" | "failed" | "cancelled" | "unavailable";
    projectId: string | null;
    clipIds?: string[];
    exportId?: string;
    failureCode?: string;
  };
}

/** Freezes the event for a terminal or unavailable Operation Status, or
 * returns null while the operation is still working. */
export function buildCallbackPayload(input: { eventId: string; workspaceId: string; createdAt: Date; status: TrustedOperationStatus }): CallbackPayload | null {
  const { status } = input;
  if (status.state === "working") return null;
  const base = { id: input.eventId, type: "operation.completed" as const, version: 1 as const, createdAt: input.createdAt.toISOString(), workspaceId: input.workspaceId };
  const operationId = encodeOperationId(status);
  if (status.state === "unavailable") {
    return { ...base, data: { operationId, kind: status.kind, state: "unavailable", projectId: null, failureCode: "project_unavailable" } };
  }
  return {
    ...base,
    data: {
      operationId,
      kind: status.kind,
      state: status.state,
      projectId: status.results.projectId,
      ...(status.results.clipIds.length ? { clipIds: status.results.clipIds } : {}),
      ...(status.results.exportId ? { exportId: status.results.exportId } : {}),
      ...(status.failureCode ? { failureCode: status.failureCode } : {}),
    },
  };
}

/** Observation backs off from about 15 seconds to a 5-minute cap. */
export function nextObservationDelayMs(observationCount: number) {
  return Math.min(OBSERVATION_MAX_DELAY_MS, OBSERVATION_FIRST_DELAY_MS * 2 ** Math.max(0, observationCount));
}

/** Delay before the next attempt after `attempts` failed deliveries, or null
 * when the retry budget is spent. */
export function nextAttemptDelayMs(attempts: number, random: () => number = Math.random) {
  const base = CALLBACK_RETRY_DELAYS_MS[attempts - 1];
  if (base === undefined) return null;
  return Math.round(base * (1 - CALLBACK_RETRY_JITTER + 2 * CALLBACK_RETRY_JITTER * random()));
}

export type DeliveryDisposition = "delivered" | "cancelled" | "retry";

export function classifyDelivery(status: number | null): DeliveryDisposition {
  if (status !== null && status >= 200 && status < 300) return "delivered";
  if (status === 410) return "cancelled";
  return "retry";
}

/** One signed POST through the pinned guard: 10 s, no redirects, and the
 * response body is never read. A fresh timestamp signs each attempt. */
export async function deliverCallback(input: {
  url: string;
  payload: CallbackPayload;
  secrets: readonly string[];
  now: Date;
  transport?: PinnedTransport;
  resolver?: HostResolver;
}): Promise<{ status: number | null; durationMs: number }> {
  const started = performance.now();
  const body = JSON.stringify(input.payload);
  const timestamp = Math.floor(input.now.getTime() / 1000);
  try {
    const response = await guardedFetch(input.url, {
      method: "POST",
      body,
      timeoutMs: CALLBACK_DELIVERY_TIMEOUT_MS,
      maxRedirects: 0,
      transport: input.transport,
      resolver: input.resolver,
      headers: {
        "content-type": "application/json",
        "user-agent": "Narriflow-Callbacks/1",
        "webhook-id": input.payload.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signCallback({ eventId: input.payload.id, timestamp, body, secrets: input.secrets }),
      },
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, durationMs: Math.round(performance.now() - started) };
  } catch {
    return { status: null, durationMs: Math.round(performance.now() - started) };
  }
}
