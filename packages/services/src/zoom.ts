import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { zoomRecordingCompletedSchema, type ZoomNotification, type ZoomRecordingFile } from "@narriflow/validators";
import { ExpectedDomainFailureError, type ExpectedDomainFailureKind } from "./expected-domain-failure";

export const ZOOM_SCOPES = ["cloud_recording:read:recording", "cloud_recording:read:list_recording_files", "user:read:user"] as const;
export const ZOOM_CALLBACK_PATH = "/api/zoom/oauth/callback";
export const ZOOM_WEBHOOK_MAX_BYTES = 1024 * 1024;

const failures = {
  zoom_not_configured: "conflict",
  zoom_signature_invalid: "forbidden",
  zoom_payload_invalid: "invalid",
  zoom_oauth_state_invalid: "forbidden",
  zoom_oauth_failed: "unprocessable",
  zoom_connection_unavailable: "conflict",
  zoom_connection_forbidden: "forbidden",
  zoom_recording_unavailable: "unprocessable",
  zoom_api_unavailable: "conflict",
  zoom_rule_changed: "conflict",
} as const satisfies Record<string, ExpectedDomainFailureKind>;

export class ZoomError extends ExpectedDomainFailureError<keyof typeof failures> {
  constructor(code: keyof typeof failures) {
    const messages: Record<keyof typeof failures, string> = {
      zoom_not_configured: "Zoom is not configured.",
      zoom_signature_invalid: "The Zoom signature is invalid or expired.",
      zoom_payload_invalid: "The Zoom notification is invalid.",
      zoom_oauth_state_invalid: "This Zoom connection request expired. Connect Zoom again.",
      zoom_oauth_failed: "Zoom could not be connected. Try connecting again.",
      zoom_connection_unavailable: "Zoom access is unavailable. Reconnect Zoom and resume its rules.",
      zoom_connection_forbidden: "Only the member who connected Zoom or a Workspace administrator can disconnect it.",
      zoom_recording_unavailable: "This Zoom recording is unavailable.",
      zoom_api_unavailable: "Zoom is temporarily unavailable. The recording will be retried.",
      zoom_rule_changed: "The Zoom rule changed before this recording was admitted.",
    };
    super({ code, kind: failures[code], message: messages[code] });
    this.name = "ZoomError";
  }
}

export function zoomConfigured(env = process.env): boolean {
  return Boolean(env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET && env.ZOOM_WEBHOOK_SECRET_TOKEN && env.SOCIAL_TOKEN_ENCRYPTION_KEY);
}

export function zoomConfig(env = process.env) {
  if (!zoomConfigured(env)) throw new ZoomError("zoom_not_configured");
  return {
    clientId: env.ZOOM_CLIENT_ID!, clientSecret: env.ZOOM_CLIENT_SECRET!,
    webhookSecret: env.ZOOM_WEBHOOK_SECRET_TOKEN!, encryptionKey: env.SOCIAL_TOKEN_ENCRYPTION_KEY!,
  };
}

export function zoomStateHash(state: string) { return createHash("sha256").update(state).digest("hex"); }

/** AES-GCM with a Zoom-specific authentication context and the same key
 * configuration as Social Accounts. Tokens never enter public snapshots. */
export function createZoomTokenCipher(rawKey: string) {
  const decoded = Buffer.from(rawKey, "base64");
  const key = decoded.length === 32 ? decoded : createHash("sha256").update(rawKey).digest();
  const aad = Buffer.from("narriflow.zoom.v1");
  return {
    seal(token: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const bytes = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(":");
    },
    open(sealed: string) {
      try {
        const [version, iv, tag, bytes] = sealed.split(":");
        if (version !== "v1" || !iv || !tag || !bytes) throw new Error();
        const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        cipher.setAAD(aad);
        cipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([cipher.update(Buffer.from(bytes, "base64url")), cipher.final()]).toString("utf8");
      } catch { throw new ZoomError("zoom_connection_unavailable"); }
    },
  };
}

/** Zoom signs the original UTF-8 body, including its whitespace. Timestamp
 * freshness prevents replay; database identities also deduplicate retries. */
export function verifyZoomSignature(input: { rawBody: string; timestamp: string | null; signature: string | null; secret: string; nowMs?: number }) {
  const { timestamp, signature } = input;
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^v0=[a-f0-9]{64}$/.test(signature) || Math.abs((input.nowMs ?? Date.now()) - Number(timestamp) * 1000) > 5 * 60_000)
    throw new ZoomError("zoom_signature_invalid");
  const expected = `v0=${createHmac("sha256", input.secret).update(`v0:${timestamp}:${input.rawBody}`).digest("hex")}`;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new ZoomError("zoom_signature_invalid");
}

export function zoomValidationChallenge(plainToken: unknown, secret: string) {
  if (typeof plainToken !== "string" || plainToken.length < 1 || plainToken.length > 1024) throw new ZoomError("zoom_payload_invalid");
  return { plainToken, encryptedToken: createHmac("sha256", secret).update(plainToken).digest("hex") };
}

export function selectZoomRecording(files: ZoomRecordingFile[]) {
  const priority = ["shared_screen_with_speaker_view", "shared_screen_with_speaker_view(CC)", "shared_screen_with_gallery_view", "speaker_view", "gallery_view", "shared_screen"];
  return files.filter((file) => file.file_type.toUpperCase() === "MP4" && file.status === "completed")
    .sort((a, b) => {
      const rank = (file: ZoomRecordingFile) => { const index = priority.indexOf(file.recording_type ?? ""); return index < 0 ? priority.length : index; };
      return rank(a) - rank(b) || (a.recording_start ?? "").localeCompare(b.recording_start ?? "") || a.id.localeCompare(b.id);
    })[0] ?? null;
}

export function zoomRecordingIdentity(meetingUuid: string, recordingId: string) {
  return `zoom:${JSON.stringify([meetingUuid, recordingId])}`;
}

export function parseZoomNotification(value: unknown): { eventKey: string; notification: ZoomNotification } | null {
  if (!value || typeof value !== "object") throw new ZoomError("zoom_payload_invalid");
  const body = value as Record<string, unknown>;
  if (body.event === "recording.completed") {
    const parsed = zoomRecordingCompletedSchema.safeParse(value);
    if (!parsed.success) throw new ZoomError("zoom_payload_invalid");
    const { object, account_id } = parsed.data.payload;
    const recording = selectZoomRecording(object.recording_files);
    if (!recording) return null;
    const start = Date.parse(recording.recording_start ?? ""), end = Date.parse(recording.recording_end ?? "");
    const seconds = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : object.duration == null ? null : object.duration * 60;
    const notification: ZoomNotification = { event: "recording.completed", eventTs: parsed.data.event_ts, accountId: account_id, hostId: object.host_id, meetingUuid: object.uuid, recordingId: recording.id, topic: object.topic, durationSeconds: seconds };
    // Zoom documents x-zm-request-id as a request identifier, not an event ID.
    // Some notifications have event_id; otherwise use the semantic event key.
    return { eventKey: zoomStateHash(JSON.stringify([body.event, account_id, parsed.data.event_id ?? [object.uuid, recording.id]])), notification };
  }
  if (body.event === "app_deauthorized") {
    const payload = body.payload as Record<string, unknown> | undefined;
    const eventTs = typeof body.event_ts === "number" ? body.event_ts : typeof payload?.event_ts === "number" ? payload.event_ts : Date.parse(String(payload?.deauthorization_time ?? ""));
    if (!payload || typeof payload.account_id !== "string" || typeof payload.user_id !== "string" || (!Number.isFinite(eventTs) || eventTs <= 0)) throw new ZoomError("zoom_payload_invalid");
    const notification: ZoomNotification = { event: "app_deauthorized", eventTs, accountId: payload.account_id, userId: payload.user_id };
    return { eventKey: zoomStateHash(JSON.stringify(notification)), notification };
  }
  return null;
}

export function zoomRecordingPath(meetingUuid: string) {
  // Zoom requires double encoding for UUIDs that begin with / or contain //.
  const encoded = encodeURIComponent(meetingUuid);
  return `/meetings/${meetingUuid.startsWith("/") || meetingUuid.includes("//") ? encodeURIComponent(encoded) : encoded}/recordings`;
}

export function assertZoomDownloadUrl(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !(url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us"))) throw new Error();
    return url.href;
  } catch { throw new ZoomError("zoom_recording_unavailable"); }
}
