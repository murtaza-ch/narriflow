import type { QueryClient } from "@tanstack/query-core";

/** API domains (spec "API modules"); the third segment of every Workspace key. */
export type ApiDomain =
  | "session"
  | "workspace"
  | "billing"
  | "ingest"
  | "recipes"
  | "projects"
  | "library"
  | "clips"
  | "studio"
  | "exports"
  | "brand"
  | "publishing"
  | "automation"
  | "reviews"
  | "developer"
  | "integrations"
  | "rest"
  | "progress"
  | "platform";

export const QUERY_KEY_ROOT = "nf";
export const GUEST_KEY_ROOT = "nf-guest";
export const SHARE_KEY_ROOT = "nf-share";
/** Third segment of identity-only (not Workspace-scoped) keys. */
export const SESSION_SEGMENT = "session";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/** Property names that would put a credential into a key; refused outright. */
const CREDENTIAL_PROPERTY = /^(authorization|token|accesstoken|sessiontoken|secret|password|passcode|grant|signature|apikey)$/i;

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Projects a filter/id into its canonical, key-sorted, JSON-safe form so equal
 * filters always produce equal keys. Only serializable values are accepted:
 * convert dates to ISO strings, bigints to decimal strings, and Sets/Maps to
 * arrays/objects before they get here. `undefined` properties are dropped;
 * everything else non-serializable throws, so a bad key fails in development
 * instead of silently splitting the cache.
 */
export function canonicalize(value: unknown, path = "$"): CanonicalValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Query key value at ${path} must be a finite number`);
      }
      return Object.is(value, -0) ? 0 : value;
    case "object":
      break;
    default:
      throw new TypeError(
        `Query key value at ${path} must be serializable (got ${typeof value}); project it first`,
      );
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) {
        throw new TypeError(`Query key array entry at ${path}[${index}] is undefined`);
      }
      return canonicalize(entry, `${path}[${index}]`);
    });
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `Query key value at ${path} must be a plain object, array or primitive; project Dates, Maps and Sets first`,
    );
  }
  const result: Record<string, CanonicalValue> = {};
  for (const name of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[name];
    if (entry === undefined) continue;
    if (CREDENTIAL_PROPERTY.test(name)) {
      throw new TypeError(`Query key property "${name}" looks like a credential and must not be keyed`);
    }
    result[name] = canonicalize(entry, `${path}.${name}`);
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export interface IdentityScope {
  readonly userId: string;
}

export interface WorkspaceScope extends IdentityScope {
  readonly workspaceId: string;
}

function tail(idOrFilters: unknown): CanonicalValue[] {
  return idOrFilters === undefined ? [] : [canonicalize(idOrFilters)];
}

/** `['nf', userId, 'session', resource, filters?]`; the identity-only bootstrap is `sessionKey(user, 'bootstrap')`. */
export function sessionKey(
  scope: IdentityScope,
  resource: string,
  idOrFilters?: unknown,
): readonly CanonicalValue[] {
  return [QUERY_KEY_ROOT, scope.userId, SESSION_SEGMENT, resource, ...tail(idOrFilters)];
}

/** `['nf', userId, workspaceId, domain, resource, idOrFilters?]`. */
export function scopedKey(
  scope: WorkspaceScope,
  domain: ApiDomain,
  resource?: string,
  idOrFilters?: unknown,
): readonly CanonicalValue[] {
  if (resource === undefined && idOrFilters !== undefined) {
    throw new TypeError("A filter key needs a resource");
  }
  return [
    QUERY_KEY_ROOT,
    scope.userId,
    scope.workspaceId,
    domain,
    ...(resource === undefined ? [] : [resource]),
    ...tail(idOrFilters),
  ];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function digestScopedKey(
  root: string,
  tokenSha256: string,
  resource: string,
  idOrFilters: unknown,
): readonly CanonicalValue[] {
  if (!SHA256_HEX.test(tokenSha256)) {
    throw new TypeError("Guest and share keys take the token's SHA-256 hex digest, never the token");
  }
  return [root, tokenSha256, resource, ...tail(idOrFilters)];
}

/** `['nf-guest', reviewTokenSha256, resource, idOrFilters?]`: guest caches never share a prefix with `nf`. */
export function guestKey(
  reviewTokenSha256: string,
  resource: string,
  idOrFilters?: unknown,
): readonly CanonicalValue[] {
  return digestScopedKey(GUEST_KEY_ROOT, reviewTokenSha256, resource, idOrFilters);
}

/** `['nf-share', shareTokenSha256, resource, idOrFilters?]` for public share pages. */
export function shareKey(
  shareTokenSha256: string,
  resource: string,
  idOrFilters?: unknown,
): readonly CanonicalValue[] {
  return digestScopedKey(SHARE_KEY_ROOT, shareTokenSha256, resource, idOrFilters);
}

/** Lowercase hex SHA-256 of a UTF-8 string, for deriving guest/share/intent digests. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is required to hash tokens");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True for any query keyed under this user's authenticated (`nf`) namespace. */
export function isUserKey(queryKey: readonly unknown[], userId: string): boolean {
  return queryKey[0] === QUERY_KEY_ROOT && queryKey[1] === userId;
}

/** True for a Workspace-scoped key (not identity-only `session` keys) of this user. */
export function isWorkspaceKey(
  queryKey: readonly unknown[],
  userId: string,
  workspaceId?: string,
): boolean {
  if (!isUserKey(queryKey, userId)) return false;
  const segment = queryKey[2];
  if (typeof segment !== "string" || segment === SESSION_SEGMENT) return false;
  return workspaceId === undefined || segment === workspaceId;
}

/** Invalidates `domain[/resource[/idOrFilters]]` inside exactly one identity + Workspace. */
export function invalidateScoped(
  queryClient: QueryClient,
  scope: WorkspaceScope,
  domain: ApiDomain,
  resource?: string,
  idOrFilters?: unknown,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: scopedKey(scope, domain, resource, idOrFilters) as unknown[],
  });
}

/** Invalidates identity-only keys such as the session bootstrap and memberships. */
export function invalidateSession(
  queryClient: QueryClient,
  scope: IdentityScope,
  resource?: string,
  idOrFilters?: unknown,
): Promise<void> {
  const base: CanonicalValue[] = [QUERY_KEY_ROOT, scope.userId, SESSION_SEGMENT];
  if (resource !== undefined) base.push(resource, ...tail(idOrFilters));
  return queryClient.invalidateQueries({ queryKey: base });
}
