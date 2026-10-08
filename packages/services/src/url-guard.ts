/**
 * Outbound fetch guard for customer- and provider-supplied URLs.
 *
 * `guardedFetch` validates every DNS answer for each hop and then connects to
 * exactly those validated addresses, so a rebinding resolver cannot swap in a
 * private address between validation and connection. TLS SNI and the Host
 * header keep the URL's hostname. Redirects are followed manually and
 * revalidated hop by hop.
 *
 * Coverage: ingest direct-media download, RSS fetch, render remote media,
 * generated media publishing, and Completion Callback delivery. yt-dlp
 * downloads run as a subprocess and never pass through this guard; their
 * egress is limited only by link intake's allowed provider hosts. Environment
 * HTTP proxies are not used, because a proxy would resolve the name again.
 * Connections speak HTTP/1.1.
 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const remoteFetchFailureCatalog = {
  remote_download_failed: "unavailable",
  remote_fetch_timeout: "unavailable",
  remote_redirect_invalid: "invalid",
  remote_redirect_limit: "invalid",
  remote_response_too_large: "unprocessable",
  remote_url_unsafe: "invalid",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type RemoteFetchErrorCode = keyof typeof remoteFetchFailureCatalog;

export class UnsafeUrlError extends ExpectedDomainFailureError<
  "remote_url_unsafe",
  { reason: string }
> {
  constructor(reason: string) {
    super({
      code: "remote_url_unsafe",
      kind: remoteFetchFailureCatalog.remote_url_unsafe,
      message: "The remote URL is not allowed",
      details: { reason },
    });
    this.name = "UnsafeUrlError";
  }
}

export class RemoteFetchError extends ExpectedDomainFailureError<RemoteFetchErrorCode> {
  constructor(code: RemoteFetchErrorCode) {
    super({ code, kind: remoteFetchFailureCatalog[code], message: "The remote media could not be fetched" });
    this.name = "RemoteFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family?: number | string;
}

export type HostResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

/** Connects to one of `addresses` (already validated) for `url` and returns
 * its response without following redirects. */
export type PinnedTransport = (
  url: URL,
  request: {
    addresses: readonly ResolvedAddress[];
    method: string;
    headers: Headers;
    body?: string | Uint8Array;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface GuardedFetchOptions {
  /** Test seam. Production connections use `pinnedTransport`. */
  transport?: PinnedTransport;
  method?: "GET" | "POST";
  body?: string | Uint8Array;
  headers?: HeadersInit;
  maxRedirects?: number;
  resolver?: HostResolver;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function normalizeHostname(hostname: string) {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255,
    )
  ) {
    return null;
  }

  return octets as [number, number, number, number];
}

function isReservedIpv4(address: string) {
  const octets = parseIpv4(address);
  if (!octets) {
    return true;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes("%")) {
    return null;
  }

  if (normalized.includes(".")) {
    const finalColon = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4(normalized.slice(finalColon + 1));
    if (finalColon < 0 || !ipv4) {
      return null;
    }
    const high = (ipv4[0] << 8) | ipv4[1];
    const low = (ipv4[2] << 8) | ipv4[3];
    normalized = `${normalized.slice(0, finalColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }

  const parts = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  return parts.map((part) => Number.parseInt(part, 16));
}

function isReservedIpv6(address: string) {
  const parts = parseIpv6(address);
  if (!parts) {
    return true;
  }

  const isMappedIpv4 =
    parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (isMappedIpv4) {
    const mapped = `${parts[6]! >> 8}.${parts[6]! & 0xff}.${parts[7]! >> 8}.${parts[7]! & 0xff}`;
    return isReservedIpv4(mapped);
  }

  // IPv6 addresses outside 2000::/3 are not globally routable unicast.
  if ((parts[0]! & 0xe000) !== 0x2000) {
    return true;
  }

  // Documentation, transition, benchmarking, and other special-purpose ranges.
  return (
    (parts[0] === 0x2001 && parts[1]! <= 0x01ff) ||
    (parts[0] === 0x2001 && parts[1] === 0x0db8) ||
    parts[0] === 0x2002 ||
    (parts[0] === 0x3fff && (parts[1]! & 0xf000) === 0)
  );
}

function isReservedAddress(address: string) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    return isReservedIpv4(normalized);
  }
  if (family === 6) {
    return isReservedIpv6(normalized);
  }
  return true;
}

function isPrivateHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

function assertPositiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function defaultResolver(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}

async function cancelBody(response: Response) {
  if (!response.body) {
    return;
  }
  await response.body.cancel().catch(() => undefined);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RemoteFetchError("remote_fetch_timeout")),
      timeoutMs,
    );
  });

  try {
    const cancellation = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([operation, timeout, cancellation]);
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Performs structural validation without network I/O. */
export function assertPublicHttpUrl(raw: string): URL {
  if (hasControlCharacters(raw)) {
    throw new UnsafeUrlError("control_character");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("bad_scheme");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials_not_allowed");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new UnsafeUrlError("private_host");
  }

  const literal = normalizeHostname(url.hostname);
  if (isIP(literal) !== 0 && isReservedAddress(literal)) {
    throw new UnsafeUrlError("private_host");
  }

  return url;
}

/** Resolves every address for a URL and fails closed if any answer is unsafe. */
export async function assertPublicHttpUrlResolved(
  raw: string | URL,
  resolver: HostResolver = defaultResolver,
): Promise<URL> {
  return (await resolvePublicHttpUrl(raw, resolver)).url;
}

/** Validates a URL and returns the exact addresses a connection may use. */
async function resolvePublicHttpUrl(
  raw: string | URL,
  resolver: HostResolver,
): Promise<{ url: URL; addresses: readonly ResolvedAddress[] }> {
  const url = assertPublicHttpUrl(raw.toString());
  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname) !== 0) {
    return { url, addresses: [{ address: hostname, family: isIP(hostname) }] };
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UnsafeUrlError("dns_resolution_failed");
  }

  if (
    addresses.length === 0 ||
    addresses.some((result) => isReservedAddress(result.address))
  ) {
    throw new UnsafeUrlError("private_address");
  }

  return { url, addresses };
}

function addressFamily(address: ResolvedAddress) {
  return isIP(normalizeHostname(address.address));
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Node `http(s).request` with a `lookup` that only answers the validated
 * addresses. Works the same under Node and Bun. */
export const pinnedTransport: PinnedTransport = (url, request) =>
  new Promise<Response>((resolve, reject) => {
    const candidates = request.addresses.filter((address) => addressFamily(address) !== 0);
    if (candidates.length === 0) {
      reject(new UnsafeUrlError("private_address"));
      return;
    }
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const family = typeof options === "object" ? options.family : undefined;
      const matching = candidates.filter((address) => !family || addressFamily(address) === family);
      const answers = (matching.length ? matching : candidates).map((address) => ({
        address: normalizeHostname(address.address),
        family: addressFamily(address),
      }));
      if (typeof options === "object" && options.all) {
        (callback as unknown as (error: null, addresses: typeof answers) => void)(null, answers);
      } else {
        callback(null, answers[0]!.address, answers[0]!.family);
      }
    };
    const hostname = normalizeHostname(url.hostname);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    headers.host = url.host;
    if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate, br";
    if (request.body !== undefined) headers["content-length"] = String(Buffer.byteLength(request.body));
    const client = url.protocol === "https:" ? https : http;
    const outgoing = client.request(
      {
        protocol: url.protocol,
        host: isIP(hostname) ? hostname : url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        lookup: pinnedLookup,
        ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
        // A dedicated agent never reuses a socket across validations and never
        // delegates to an environment proxy, which would resolve the name again.
        agent: url.protocol === "https:" ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false }),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new RemoteFetchError("remote_download_failed"));
          return;
        }
        const responseHeaders = new Headers();
        for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
        const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
          : encoding === "deflate" ? createInflate()
          : encoding === "br" ? createBrotliDecompress() : null;
        let body: Readable = incoming;
        if (decoder) {
          // Match fetch: callers see decoded bytes and no encoded length.
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          body = incoming.pipe(decoder);
          incoming.on("error", (error) => decoder.destroy(error));
        }
        if (NULL_BODY_STATUSES.has(status) || request.method === "HEAD") {
          incoming.resume();
        }
        const response = new Response(
          NULL_BODY_STATUSES.has(status) || request.method === "HEAD"
            ? null
            : (Readable.toWeb(body) as ReadableStream<Uint8Array>),
          { status, statusText: incoming.statusMessage, headers: responseHeaders },
        );
        Object.defineProperty(response, "url", { value: url.toString() });
        resolve(response);
      },
    );
    const abort = () => outgoing.destroy(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted"));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    outgoing.on("close", () => request.signal.removeEventListener("abort", abort));
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });

/** Fetches a public URL while manually validating every redirect hop. */
export async function guardedFetch(
  raw: string | URL,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  options.signal?.throwIfAborted();
  const transport = options.transport ?? pinnedTransport;
  const resolver = options.resolver ?? defaultResolver;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertPositiveLimit(timeoutMs, "timeoutMs");
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError("maxRedirects must be a non-negative safe integer");
  }

  let current = assertPublicHttpUrl(raw.toString());
  const headers = new Headers(options.headers);
  let redirectCount = 0;

  while (true) {
    options.signal?.throwIfAborted();
    const resolved = await withTimeout(
      resolvePublicHttpUrl(current, resolver),
      timeoutMs,
      options.signal,
    );
    current = resolved.url;
    options.signal?.throwIfAborted();

    let response: Response;
    try {
      // The timeout also bounds the body, as it did with fetch.
      response = await transport(current, {
        addresses: resolved.addresses,
        method: options.method ?? "GET",
        headers,
        body: options.body,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof UnsafeUrlError || error instanceof RemoteFetchError) {
        throw error;
      }
      if (isTimeoutError(error)) {
        throw new RemoteFetchError("remote_fetch_timeout");
      }
      throw new RemoteFetchError("remote_download_failed");
    }

    // Only GET follows redirects; other methods report the 3xx response.
    if (!REDIRECT_STATUSES.has(response.status) || (options.method ?? "GET") !== "GET") {
      return response;
    }

    if (redirectCount >= maxRedirects) {
      await cancelBody(response);
      throw new RemoteFetchError("remote_redirect_limit");
    }

    const location = response.headers.get("location");
    let next: URL;
    try {
      if (!location || hasControlCharacters(location)) {
        throw new Error("invalid redirect");
      }
      next = new URL(location, current);
    } catch {
      await cancelBody(response);
      throw new RemoteFetchError("remote_redirect_invalid");
    }

    await cancelBody(response);
    if (next.origin !== current.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }

    current = next;
    redirectCount += 1;
  }
}

export function assertResponseContentLength(
  response: Response,
  maxBytes: number,
) {
  assertPositiveLimit(maxBytes, "maxBytes");
  const rawLength = response.headers.get("content-length");
  if (!rawLength) {
    return;
  }

  const length = Number(rawLength);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new RemoteFetchError("remote_response_too_large");
  }
}

export async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  try {
    assertResponseContentLength(response, maxBytes);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteFetchError("remote_response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RemoteFetchError) {
      throw error;
    }
    if (isTimeoutError(error)) {
      throw new RemoteFetchError("remote_fetch_timeout");
    }
    throw new RemoteFetchError("remote_download_failed");
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
) {
  return new TextDecoder().decode(
    await readResponseBodyBounded(response, maxBytes),
  );
}

/** Node transform for bounded streaming to disk. */
export function createByteLimitTransform(maxBytes: number) {
  assertPositiveLimit(maxBytes, "maxBytes");
  let totalBytes = 0;

  return new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        callback(new RemoteFetchError("remote_response_too_large"));
        return;
      }
      callback(null, chunk);
    },
  });
}
