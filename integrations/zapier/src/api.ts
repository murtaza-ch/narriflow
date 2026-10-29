import type { Bundle, ZObject } from 'zapier-platform-core';

/** Local API default. Hosted connections configure their public HTTPS API origin. */
export const DEFAULT_BASE_URL = 'http://localhost:4000';

type Query = Record<string, string | number | boolean | undefined>;

export interface ApiRequest {
  method?: 'GET' | 'POST';
  /** A path under /api/v1, such as `/projects/{id}`. */
  path: string;
  query?: Query;
  body?: unknown;
  /** Required by every endpoint that starts work. */
  idempotencyKey?: string;
}

export interface ApiResponse<T> {
  data: T;
  /** The API answered from an earlier request that used the same Idempotency-Key. */
  replayed: boolean;
}

interface ApiError {
  error?: string;
  message?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  details?: { scope?: string };
}

type Response = Awaited<ReturnType<ZObject['request']>>;

type Connection = Pick<Bundle, 'authData'>;

/** `https://host/api/v1` for the connection's Narriflow URL. */
export function apiRoot(z: ZObject, bundle: Connection): string {
  const configured = String(bundle.authData?.baseUrl ?? '').trim();
  let url: URL;
  try {
    url = new URL(configured || DEFAULT_BASE_URL);
  } catch {
    throw new z.errors.Error(`"${configured}" is not a URL. Use an address such as ${DEFAULT_BASE_URL}.`, 'invalid_base_url', 400);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new z.errors.Error('The Narriflow URL must start with https://.', 'invalid_base_url', 400);
  }
  // Only the origin matters: people paste the API origin or its /api/v1 path.
  return `${url.origin}/api/v1`;
}

async function send<T>(z: ZObject, bundle: Connection, request: ApiRequest) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bundle.authData?.apiKey ?? ''}`,
    Accept: 'application/json',
  };
  if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
  const params = Object.fromEntries(Object.entries(request.query ?? {}).filter(([, value]) => value !== undefined));
  const response = await z.request({
    method: request.method ?? 'GET',
    url: `${apiRoot(z, bundle)}${request.path}`,
    headers,
    params,
    ...(request.body === undefined ? {} : { body: request.body as object }),
    // Errors are mapped below so Zaps show Narriflow's own message and delay.
    skipThrowForStatus: true,
    ...({ throwForThrottlingEarly: false } as object),
  });
  return { response, data: response.data as T };
}

/** Seconds to wait, from the error body or the Retry-After header. */
function retryDelay(response: Response, error: ApiError): number | undefined {
  if (typeof error.retryAfterSeconds === 'number') return error.retryAfterSeconds;
  const header = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  return Number.isNaN(header) ? undefined : header;
}

/** Turns an error response into the Zapier error that makes Zapier do the right thing. */
function fail(z: ZObject, response: Response): never {
  const error = (response.data && typeof response.data === 'object' ? response.data : {}) as ApiError;
  const status = response.status;
  const code = typeof error.error === 'string' ? error.error : `http_${status}`;
  const message = typeof error.message === 'string' ? error.message : `Narriflow answered HTTP ${status}.`;
  const reference = typeof error.requestId === 'string' ? ` (request ${error.requestId})` : '';
  // The key is wrong or revoked: Zapier asks the person to reconnect.
  if (status === 401) throw new z.errors.ExpiredAuthError(`${message}${reference} Reconnect Narriflow with a valid API key.`);
  // Zapier retries these later, after the delay Narriflow asked for.
  if (status === 429 || status === 503) throw new z.errors.ThrottledError(message, retryDelay(response, error));
  if (status === 403 && code === 'scope_required') {
    const scope = error.details?.scope;
    throw new z.errors.Error(
      scope
        ? `This API key does not have the ${scope} permission. Turn it on for the key in Narriflow under Settings, then Developer access, or create a new key, and reconnect.${reference}`
        : `${message}${reference}`,
      code,
      status,
    );
  }
  throw new z.errors.Error(`${message}${reference}`, code, status);
}

/** Calls the REST API and throws a Zapier error carrying Narriflow's message on any failure. */
export async function api<T>(z: ZObject, bundle: Connection, request: ApiRequest): Promise<ApiResponse<T>> {
  const { response, data } = await send<T>(z, bundle, request);
  if (response.status >= 400) fail(z, response);
  return { data, replayed: response.headers.get('idempotent-replayed') === 'true' };
}

/** Like `api`, but a 404 means the subject is gone and returns null. */
export async function apiOrNull<T>(z: ZObject, bundle: Connection, request: ApiRequest): Promise<T | null> {
  const { response, data } = await send<T>(z, bundle, request);
  if (response.status === 404) return null;
  if (response.status >= 400) fail(z, response);
  return data;
}
