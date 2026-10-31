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
import { type LookupFunction } from "node:net";
import { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import {
  assertPublicHttpUrl, hasControlCharacters, assertPositiveLimit, normalizeHostname, isReservedAddress, ipFamily as isIP,
  RemoteFetchError, UnsafeUrlError, type HostResolver, type ResolvedAddress, type PinnedTransport, type GuardedFetchOptions,
} from "@narriflow/services/url-policy";
export * from "@narriflow/services/url-policy";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301,302,303,307,308]);
function isTimeoutError(error: unknown) { return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"); }
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
        // Bodyless responses never reach a decoder: an empty "gzip" body
        // would otherwise fail asynchronously outside the caller's control.
        if (NULL_BODY_STATUSES.has(status) || request.method === "HEAD") {
          incoming.resume();
          const response = new Response(null, { status, statusText: incoming.statusMessage, headers: responseHeaders });
          Object.defineProperty(response, "url", { value: url.toString() });
          resolve(response);
          return;
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
        const response = new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>,
          { status, statusText: incoming.statusMessage, headers: responseHeaders });
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
