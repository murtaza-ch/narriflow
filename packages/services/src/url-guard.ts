import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Transform } from "node:stream";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`unsafe_url:${reason}`);
    this.name = "UnsafeUrlError";
  }
}

export type RemoteFetchErrorCode =
  | "remote_download_failed"
  | "remote_fetch_timeout"
  | "remote_redirect_invalid"
  | "remote_redirect_limit"
  | "remote_response_too_large";

export class RemoteFetchError extends Error {
  constructor(public readonly code: RemoteFetchErrorCode) {
    super(code);
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

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface GuardedFetchOptions {
  fetchImpl?: FetchImplementation;
  headers?: HeadersInit;
  maxRedirects?: number;
  resolver?: HostResolver;
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

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RemoteFetchError("remote_fetch_timeout")),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
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
  const url = assertPublicHttpUrl(raw.toString());
  const hostname = normalizeHostname(url.hostname);

  if (isIP(hostname) !== 0) {
    return url;
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

  return url;
}

/** Fetches a public URL while manually validating every redirect hop. */
export async function guardedFetch(
  raw: string | URL,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
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
    current = await withTimeout(
      assertPublicHttpUrlResolved(current, resolver),
      timeoutMs,
    );

    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new RemoteFetchError("remote_fetch_timeout");
      }
      throw new RemoteFetchError("remote_download_failed");
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
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
