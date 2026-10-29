import { API_PLATFORM_ERROR_CODES } from "@narriflow/validators/api/errors";
import {
  ApiError,
  apiErrorFromResponse,
  CLIENT_ERROR_CODES,
  scopeChangedError,
} from "./error";
import type { IdentityScope, WorkspaceScope } from "./keys";
import type { ApiScope, ScopeTarget, TrackedRequest } from "./scope";

export const AUTHORIZATION_HEADER = "Authorization";
export const WORKSPACE_HEADER = "X-Workspace-Id";
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const CAMPAIGN_RETRY_OF_HEADER = "Campaign-Retry-Of";

export interface GetTokenOptions {
  /** Bypass the token cache; used for the single retry after a 401. */
  skipCache?: boolean;
}

export type GetToken = (options?: GetTokenOptions) => Promise<string | null>;

export interface TransportOptions {
  /** Full API origin, e.g. `https://api.example.com`. Requests to any other origin are refused. */
  baseUrl: string;
  scope: ApiScope;
  /** Supplies the current session token at request time. Never cached or logged here. */
  getToken: GetToken;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Called once when a request ends unauthenticated (no token, or 401 after one forced refresh). */
  onAuthenticationFailed?: (error: ApiError) => void;
  /** Called when the API refuses the explicit Workspace selection (409 `workspace_selection_changed`). */
  onWorkspaceSelectionChanged?: (error: ApiError) => void;
}

type QueryValue = string | number | boolean | null | undefined;

export interface JsonRequestOptions<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Readonly<Record<string, QueryValue | readonly QueryValue[]>>;
  /** Serialized as the JSON body. */
  json?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Minted once per user intent (see `createIntent`); sent as `Idempotency-Key`. */
  idempotencyKey?: string;
  /** Validates/narrows the parsed body (for example `schema.parse`). */
  parse?: (data: unknown) => T;
}

interface Performed extends OpenedResponse {
  tracked: TrackedRequest;
}

export interface OpenedResponse {
  response: Response;
  /** Stops scope tracking; call when the body is finished or abandoned. */
  release(): void;
}

/**
 * Calls bound to one explicit identity (+ Workspace). The `X-Workspace-Id`
 * header comes from the bound scope, never from ambient state, and every call
 * is refused if that scope is no longer the current one.
 *
 * `fetch` is shaped for Hono's `hc(baseUrl, { fetch })` (or per call
 * `$get(args, { fetch })`). Non-2xx responses throw `ApiError`. The returned
 * body stays scope-tracked until it is consumed or cancelled, so a Workspace
 * switch during `await response.json()` rejects with `scope_changed`.
 */
export interface BoundTransport {
  readonly baseUrl: string;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, options?: JsonRequestOptions<T>): Promise<T>;
  /** Streaming responses (SSE): scope tracking continues until `release()`. */
  open(path: string, init?: RequestInit): Promise<OpenedResponse>;
}

export interface ApiTransport {
  readonly baseUrl: string;
  /** Workspace-scoped calls for exactly this identity and Workspace. */
  scoped(scope: WorkspaceScope): BoundTransport;
  /** Identity-only calls (session bootstrap, workspace selection); no Workspace header. */
  identity(scope: IdentityScope): BoundTransport;
}

const MAX_KEY_LENGTH = 128;

function normalizeBaseUrl(value: string): URL {
  const base = new URL(value);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("baseUrl must be an http(s) origin");
  }
  if (base.username || base.password) {
    throw new TypeError("baseUrl must not contain credentials");
  }
  return new URL(base.origin);
}

function resolveUrl(input: string | URL, base: URL): URL {
  if (typeof input !== "string" && !(input instanceof URL)) {
    throw new TypeError("Pass a URL or path and an init object, not a Request");
  }
  const url = new URL(input, base);
  if (url.origin !== base.origin || url.username || url.password) {
    // The bearer token must never be sent anywhere but the configured API.
    throw new TypeError("Refusing to send credentials to a different origin");
  }
  return url;
}

function appendQuery(url: URL, query: JsonRequestOptions<unknown>["query"]): void {
  if (!query) return;
  for (const [name, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values as QueryValue[]) {
      if (entry === undefined || entry === null) continue;
      url.searchParams.append(name, String(entry));
    }
  }
}

function isStreamBody(body: RequestInit["body"]): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

/** Releases a hold whose owner (a body stream or a cloned Response) was dropped without being read. */
const abandoned =
  typeof FinalizationRegistry === "undefined"
    ? undefined
    : new FinalizationRegistry<() => void>((release) => release());

/**
 * Keeps one tracked request alive until every reader of its body is done. The
 * body stream holds one reference; the Response and each of its clones hold
 * another once `clone()` is called (a clone reads from a buffered tee branch
 * that outlives the original). Defined at module level so the release closures
 * capture nothing that would keep a registered owner reachable.
 */
function createLease(tracked: TrackedRequest): { hold(): () => void; close(): void } {
  let holders = 0;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    tracked.release();
  };
  return {
    hold() {
      holders += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holders -= 1;
        if (holders === 0) close();
      };
    },
    /** The body failed or was cancelled for every reader: nothing is left to protect. */
    close,
  };
}

const BODY_READERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

export function createApiTransport(options: TransportOptions): ApiTransport {
  const base = normalizeBaseUrl(options.baseUrl);
  const { scope } = options;
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const assertCurrent = (target: ScopeTarget, tracked?: TrackedRequest): void => {
    if (tracked?.scopeAborted || !scope.isCurrent(target)) throw scopeChangedError();
  };

  const requireToken = async (skipCache: boolean): Promise<string> => {
    let token: string | null;
    try {
      token = await options.getToken(skipCache ? { skipCache: true } : undefined);
    } catch (cause) {
      throw new ApiError({
        code: API_PLATFORM_ERROR_CODES.authenticationUnavailable,
        message: "Could not obtain a session token.",
        status: 0,
        cause,
      });
    }
    if (!token) {
      throw new ApiError({
        code: API_PLATFORM_ERROR_CODES.authenticationRequired,
        message: "Sign in to continue.",
        status: 401,
      });
    }
    return token;
  };

  const buildHeaders = (init: RequestInit, target: ScopeTarget, token: string): Headers => {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`);
    if (target.workspaceId === null) headers.delete(WORKSPACE_HEADER);
    else headers.set(WORKSPACE_HEADER, target.workspaceId);
    return headers;
  };

  const attempt = async (
    url: URL,
    init: RequestInit,
    target: ScopeTarget,
    tracked: TrackedRequest,
    skipCache: boolean,
  ): Promise<Response> => {
    const token = await requireToken(skipCache);
    assertCurrent(target, tracked);
    return send(url.toString(), {
      ...init,
      headers: buildHeaders(init, target, token),
      credentials: "omit",
      signal: tracked.signal,
    });
  };

  const discard = (response: Response): void => {
    void response.body?.cancel().catch(() => undefined);
  };

  const toFailure = (
    error: unknown,
    tracked: TrackedRequest,
    external: AbortSignal | undefined,
  ): unknown => {
    if (tracked.scopeAborted) return scopeChangedError();
    if (error instanceof ApiError) return error;
    if (external?.aborted) return error;
    return new ApiError({
      code: CLIENT_ERROR_CODES.network,
      message: "Could not reach the server.",
      status: 0,
      cause: error,
    });
  };

  const notifyFailure = (error: ApiError): void => {
    if (error.status === 401) options.onAuthenticationFailed?.(error);
    else if (error.code === API_PLATFORM_ERROR_CODES.workspaceSelectionChanged) {
      options.onWorkspaceSelectionChanged?.(error);
    }
  };

  /**
   * Hands the caller a Response whose body stays under scope tracking until it
   * is read to the end, errors or is cancelled. A Workspace switch or sign-out
   * mid-body errors the stream with `scope_changed`, the caller's own abort
   * still surfaces as that abort, and the end of the body is refused if the
   * scope moved even when the underlying fetch ignored the abort. A body that is
   * dropped without being read is released when its stream is collected.
   *
   * Cloning shares the tracked request: the body stream, the Response and every
   * clone each hold it, and a clone's body reader (or `.json()`, `.text()`...)
   * ends with a scope check of its own. So the original being collected, or
   * finishing first, cannot release tracking while another reader (or its
   * buffered tee branch) is still to be read, and an A to B to A move is still
   * a change for every one of them.
   */
  const guardBody = (
    response: Response,
    target: ScopeTarget,
    tracked: TrackedRequest,
    external: AbortSignal | undefined,
  ): Response => {
    const source = response.body;
    if (!source) {
      tracked.release();
      return response;
    }
    const lease = createLease(tracked);
    const releaseSource = lease.hold();
    const reader = source.getReader();
    let onAbort: (() => void) | undefined;
    let settled = false;
    const settle = (terminal = true): void => {
      if (settled) return;
      settled = true;
      if (terminal) lease.close();
      else releaseSource();
      if (onAbort) tracked.signal.removeEventListener("abort", onAbort);
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          onAbort = () => {
            settle();
            controller.error(toFailure(tracked.signal.reason, tracked, external));
            void reader.cancel().catch(() => undefined);
          };
          if (tracked.signal.aborted) onAbort();
          else tracked.signal.addEventListener("abort", onAbort, { once: true });
        },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            assertCurrent(target, tracked);
            if (chunk.done) {
              // Clones may still hold buffered bytes: they keep tracking alive.
              settle(false);
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            settle();
            controller.error(toFailure(error, tracked, external));
            void reader.cancel().catch(() => undefined);
          }
        },
        cancel(reason) {
          settle();
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const guarded = new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // The stream outlives the Response while any clone's tee branch reads from it.
    abandoned?.register(stream, releaseSource);
    guarded.clone = () => {
      enroll(guarded);
      return guarded.clone();
    };

    /** Makes `instance` (the original once cloned, or a clone) a holder with its own end-of-read scope check. */
    function enroll(instance: Response): void {
      const release = lease.hold();
      abandoned?.register(instance, release);
      const record = instance as unknown as Record<string, unknown>;
      for (const name of BODY_READERS) {
        const read = record[name];
        if (typeof read !== "function") continue;
        record[name] = async (...args: unknown[]): Promise<unknown> => {
          try {
            const value = await (read as (...a: unknown[]) => Promise<unknown>).apply(instance, args);
            assertCurrent(target, tracked);
            return value;
          } catch (error) {
            throw toFailure(error, tracked, external);
          } finally {
            release();
          }
        };
      }
      instance.clone = () => {
        const copy = Response.prototype.clone.call(instance) as Response;
        enroll(copy);
        return copy;
      };
    }
    return guarded;
  };

  /** Sends one logical request: token, at most one forced refresh on 401, scope checks, error mapping. */
  const perform = async (
    target: ScopeTarget,
    url: URL,
    init: RequestInit,
  ): Promise<Performed> => {
    const external = init.signal ?? undefined;
    const tracked = scope.track(target, external);
    try {
      assertCurrent(target);
      let response = await attempt(url, init, target, tracked, false);
      if (response.status === 401 && !isStreamBody(init.body)) {
        discard(response);
        response = await attempt(url, init, target, tracked, true);
      }
      if (tracked.scopeAborted || !scope.isCurrent(target)) {
        discard(response);
        throw scopeChangedError();
      }
      if (!response.ok) throw await apiErrorFromResponse(response);
      const admitted = response.headers.get(WORKSPACE_HEADER);
      if (target.workspaceId !== null && admitted !== null && admitted !== target.workspaceId) {
        discard(response);
        throw new ApiError({
          code: CLIENT_ERROR_CODES.workspaceResponseMismatch,
          message: "The response was for a different Workspace and was discarded.",
          status: response.status,
        });
      }
      return { response, release: tracked.release, tracked };
    } catch (error) {
      tracked.release();
      const failure = toFailure(error, tracked, external);
      if (failure instanceof ApiError && failure.code !== CLIENT_ERROR_CODES.scopeChanged) {
        notifyFailure(failure);
      }
      throw failure;
    }
  };

  const bind = (target: ScopeTarget): BoundTransport => ({
    baseUrl: base.origin,

    async fetch(input, init = {}) {
      const url = resolveUrl(input, base);
      const { response, tracked } = await perform(target, url, init);
      return guardBody(response, target, tracked, init.signal ?? undefined);
    },

    async open(path, init = {}) {
      const { response, release } = await perform(target, resolveUrl(path, base), init);
      return { response, release };
    },

    async json<T>(path: string, request: JsonRequestOptions<T> = {}): Promise<T> {
      const url = resolveUrl(path, base);
      appendQuery(url, request.query);
      const headers = new Headers(request.headers);
      if (request.idempotencyKey !== undefined) {
        if (request.idempotencyKey.length < 1 || request.idempotencyKey.length > MAX_KEY_LENGTH) {
          throw new TypeError("Idempotency keys are 1-128 characters");
        }
        headers.set(IDEMPOTENCY_KEY_HEADER, request.idempotencyKey);
      }
      let body: string | undefined;
      if (request.json !== undefined) {
        body = JSON.stringify(request.json);
        headers.set("Content-Type", "application/json");
      }
      const init: RequestInit = {
        method: request.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        signal: request.signal,
      };
      const { response, release, tracked } = await perform(target, url, init);
      try {
        const text = await response.text();
        assertCurrent(target, tracked);
        const data: unknown = text ? parseJsonBody(text, response.status) : undefined;
        return request.parse ? request.parse(data) : (data as T);
      } catch (error) {
        throw toFailure(error, tracked, request.signal);
      } finally {
        release();
      }
    },
  });

  return {
    baseUrl: base.origin,
    scoped: (workspaceScope) =>
      bind({ userId: workspaceScope.userId, workspaceId: requireWorkspace(workspaceScope) }),
    identity: (identityScope) => bind({ userId: identityScope.userId, workspaceId: null }),
  };
}

function requireWorkspace(scope: WorkspaceScope): string {
  if (!scope.workspaceId) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.workspaceSelectionRequired,
      message: "Select a Workspace to continue.",
      status: 0,
    });
  }
  return scope.workspaceId;
}

function parseJsonBody(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.unexpectedResponse,
      message: "The server response was not valid JSON.",
      status,
      cause,
    });
  }
}
