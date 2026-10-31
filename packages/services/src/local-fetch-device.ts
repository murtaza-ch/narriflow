import { localFetchDeviceClaimsSchema, localFetchWorkspaceIdsSchema, type LocalFetchDeviceClaims } from "@narriflow/validators/api/local-fetch";
export type { LocalFetchDeviceClaims } from "@narriflow/validators/api/local-fetch";

export const LOCAL_FETCH_SESSION_MS = 2 * 60 * 60_000;
export class LocalFetchDeviceError extends Error {
  constructor(readonly code: "local_fetch_session_invalid" | "local_fetch_unavailable") { super(code); }
}
export function requireLocalFetchDevelopment(environment: Readonly<Record<string, string | undefined>>, workspaceId: string) {
  let allowed: unknown;
  try { allowed = JSON.parse(environment.LOCAL_FETCH_WORKSPACE_IDS_JSON ?? "[]"); } catch { /* Refuse malformed configuration. */ }
  if (environment.APP_ENV !== "development" || environment.YOUTUBE_FETCH_MODE !== "local" ||
    !localFetchWorkspaceIdsSchema.safeParse(allowed).success || !(allowed as string[]).includes(workspaceId)) {
    throw new LocalFetchDeviceError("local_fetch_unavailable");
  }
}
function encode(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64url"); }
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new LocalFetchDeviceError("local_fetch_session_invalid");
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (encode(bytes) !== value) throw new LocalFetchDeviceError("local_fetch_session_invalid");
  return bytes;
}
/** The device receives its own derived key. It never receives the root ring,
 * database credentials, provider credentials or authority for another session. */
export function createLocalFetchDeviceCodec(keys: ReadonlyMap<string, Uint8Array>) {
  async function key(id: string) {
    const bytes = keys.get(id);
    if (!bytes || bytes.byteLength < 32 || bytes.byteLength > 64) throw new LocalFetchDeviceError("local_fetch_session_invalid");
    return crypto.subtle.importKey("raw", bytes as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  function validate(claims: LocalFetchDeviceClaims, nowMs: number) {
    const origin = new URL(claims.apiOrigin);
    if (origin.protocol !== "https:" || origin.origin !== claims.apiOrigin || claims.expiresAt !== claims.issuedAt + LOCAL_FETCH_SESSION_MS ||
      claims.issuedAt > nowMs + 5000 || claims.expiresAt <= nowMs) throw new LocalFetchDeviceError("local_fetch_session_invalid");
  }
  async function scopedKey(root: CryptoKey, payload: string) {
    return new Uint8Array(await crypto.subtle.sign("HMAC", root, new TextEncoder().encode(`narriflow-local-fetch-key-v1\n${payload}`)));
  }
  return {
    async issue(scope: Pick<LocalFetchDeviceClaims, "workspaceId" | "actorUserId" | "deploymentEpoch" | "apiOrigin">, keyId: string, nowMs = Date.now()) {
      const claims = localFetchDeviceClaimsSchema.parse({ ...scope, version: 1, keyId, sessionId: crypto.randomUUID(), issuedAt: nowMs, expiresAt: nowMs + LOCAL_FETCH_SESSION_MS });
      validate(claims, nowMs);
      const payload = encode(new TextEncoder().encode(JSON.stringify(claims))), root = await key(keyId);
      const signature = await crypto.subtle.sign("HMAC", root, new TextEncoder().encode(`narriflow-local-fetch-session-v1\n${payload}`));
      return { token: `${payload}.${encode(new Uint8Array(signature))}`, claims, key: await scopedKey(root, payload) };
    },
    async verify(token: string, nowMs = Date.now()) {
      try {
        if (token.length > 2048) throw new Error();
        const [payload, signature, extra] = token.split(".");
        if (!payload || !signature || extra !== undefined) throw new Error();
        const claims = localFetchDeviceClaimsSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(payload))));
        validate(claims, nowMs);
        const root = await key(claims.keyId);
        if (!await crypto.subtle.verify("HMAC", root, decode(signature) as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`narriflow-local-fetch-session-v1\n${payload}`))) throw new Error();
        return { claims, key: await scopedKey(root, payload) };
      } catch { throw new LocalFetchDeviceError("local_fetch_session_invalid"); }
    },
  };
}
