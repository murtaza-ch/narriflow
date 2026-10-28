import { ApiError } from "@narriflow/api-client/core";
import { type StudioApi, apiFailureStatus, studioClientFor } from "./studio-api";

/**
 * HTTP adapter the Studio Editing Session's cloud dependency is built on. It
 * only moves bytes: revision guards, retries, conflicts and Device Draft
 * handling stay in the session. `send` resolves with the status and parsed
 * body of any response the API produced (including refusals) and rejects only
 * when none arrived, so the session's existing outcome classification is
 * unchanged.
 */
export interface StudioCloudResponse {
  status: number;
  body: unknown;
}

export interface StudioCloudHttp {
  load(): Promise<StudioCloudResponse>;
  save(input: { baseRevision: number; document: unknown }): Promise<StudioCloudResponse>;
  reset(input: { baseRevision: number }): Promise<StudioCloudResponse>;
  /**
   * Close-time best-effort write. Synchronous, never awaits Clerk: it uses the
   * token snapshot captured while the Studio was active. Returns false when the
   * write cannot be sent (no usable token, scope moved, body over the browser's
   * keepalive budget); the Device Draft is the only copy then and stays intact.
   */
  keepalive(input: { baseRevision: number; document: unknown }): boolean;
}

/** Browsers cap the bodies of in-flight keepalive requests at 64 KiB combined; stay well inside. */
export const KEEPALIVE_MAX_BODY_BYTES = 48 * 1024;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A refusal's envelope, as the session's classifier expects it. */
function envelopeOf(error: ApiError): unknown {
  return {
    error: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
}

async function settle(request: () => Promise<Response>): Promise<StudioCloudResponse> {
  try {
    const response = await request();
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    const status = apiFailureStatus(error);
    if (status !== null && error instanceof ApiError) return { status, body: envelopeOf(error) };
    throw error;
  }
}

// ─── Token snapshot ──────────────────────────────────────────────────────────

export interface TokenSnapshot {
  /** The latest captured token, or null when none is held or it is about to expire. */
  current(): string | null;
  /** Captures a fresh token; never rejects. */
  refresh(): Promise<void>;
}

/** Expiry (ms since epoch) of a JWT, read without verifying it; null when unreadable. */
export function tokenExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A snapshot unusable within this long of expiry: the request would arrive after it. */
const MIN_REMAINING_MS = 1_500;

export function createTokenSnapshot(options: {
  getToken: () => Promise<string | null>;
  now?: () => number;
}): TokenSnapshot {
  const now = options.now ?? Date.now;
  let held: { token: string; expiresAtMs: number } | null = null;
  return {
    current() {
      if (!held || held.expiresAtMs - now() < MIN_REMAINING_MS) return null;
      return held.token;
    },
    async refresh() {
      try {
        const token = await options.getToken();
        const expiresAtMs = token ? tokenExpiryMs(token) : null;
        held = token && expiresAtMs !== null ? { token, expiresAtMs } : null;
      } catch {
        // Keep the previous capture; current() already refuses it once it expires.
      }
    },
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function createStudioCloudHttp(options: {
  api: StudioApi;
  projectId: string;
  clipId: string;
  tokens: TokenSnapshot;
  fetchImpl?: typeof fetch;
}): StudioCloudHttp {
  const { api, projectId, clipId, tokens } = options;
  const param = { id: projectId, clipId };
  const client = () => studioClientFor(api).projects[":id"].clips[":clipId"].editor;
  // Hono's JSON input type is the schema's; the session already holds a validated document.
  type SaveJson = Parameters<ReturnType<typeof client>["$put"]>[0]["json"];

  return {
    load: () => settle(() => client().$get({ param })),
    save: ({ baseRevision, document }) =>
      settle(() => client().$put({ param, json: { baseRevision, document } as SaveJson })),
    reset: ({ baseRevision }) => settle(() => client().reset.$post({ param, json: { baseRevision } })),
    keepalive({ baseRevision, document }) {
      const token = tokens.current();
      if (!token) return false;
      const target = api.runtime.scope.snapshot();
      if (target.userId !== api.scope.userId || target.workspaceId !== api.scope.workspaceId) return false;
      const body = JSON.stringify({ baseRevision, document });
      if (byteLength(body) > KEEPALIVE_MAX_BODY_BYTES) return false;
      const url = client().$url({ param }).toString();
      const send = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
      void Promise.resolve(
        send(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Workspace-Id": api.scope.workspaceId,
            "Content-Type": "application/json",
          },
          body,
          keepalive: true,
          credentials: "omit",
        }),
      ).catch(() => undefined);
      return true;
    },
  };
}
