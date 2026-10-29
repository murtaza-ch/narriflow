import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { WorkerMediaInspection } from "./worker-process";

/**
 * Immutable render facts a worker process may reuse across clips and attempts.
 * Every key names content that cannot change under it: a font or media file by
 * SHA-256, a source by its write-once object key and byte size. A fact is never
 * keyed by anything mutable (a URL, an editor revision), so a changed source,
 * font or asset misses and is recomputed. The cache lives as long as the worker
 * process, which fixes the FFmpeg/ffprobe toolchain those facts came from.
 * Failures are never remembered, only complete positive facts.
 */

const FONT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const VALIDATION_CACHE_MAX_ENTRIES = 512;
const SOURCE_PROBE_CACHE_MAX_ENTRIES = 16;

export type RenderFactKind = "font" | "mediaValidation" | "sourceProbe";

export interface RenderFactCounts {
  hits: number;
  misses: number;
}

export class RenderFactCache {
  private readonly fontEntries = new Map<string, Buffer>();
  private fontBytes = 0;
  private readonly validated = new Set<string>();
  private readonly probes = new Map<string, WorkerMediaInspection>();
  private readonly counts: Record<RenderFactKind, RenderFactCounts> = {
    font: { hits: 0, misses: 0 },
    mediaValidation: { hits: 0, misses: 0 },
    sourceProbe: { hits: 0, misses: 0 },
  };

  /** Hit and miss totals since the process started, for diagnostics. */
  stats(): Record<RenderFactKind, RenderFactCounts> {
    return {
      font: { ...this.counts.font },
      mediaValidation: { ...this.counts.mediaValidation },
      sourceProbe: { ...this.counts.sourceProbe },
    };
  }

  /** Bytes of a font whose SHA-256 is its fingerprint. */
  font(fingerprint: string): Buffer | undefined {
    const bytes = this.fontEntries.get(fingerprint);
    if (!bytes) {
      this.counts.font.misses += 1;
      return undefined;
    }
    // Refresh recency.
    this.fontEntries.delete(fingerprint);
    this.fontEntries.set(fingerprint, bytes);
    this.counts.font.hits += 1;
    return bytes;
  }

  /** Remembers font bytes only when they hash to the fingerprint they claim. */
  rememberFont(fingerprint: string, bytes: Buffer): void {
    if (bytes.length > FONT_CACHE_MAX_BYTES || this.fontEntries.has(fingerprint)) return;
    if (createHash("sha256").update(bytes).digest("hex") !== fingerprint) return;
    this.fontEntries.set(fingerprint, bytes);
    this.fontBytes += bytes.length;
    for (const [key, evicted] of this.fontEntries) {
      if (this.fontBytes <= FONT_CACHE_MAX_BYTES) break;
      this.fontEntries.delete(key);
      this.fontBytes -= evicted.length;
    }
  }

  /** True when these exact bytes already decoded as the requested media kind. */
  isValidated(kind: string, contentSha256: string): boolean {
    const hit = this.validated.has(`${kind}:${contentSha256}`);
    this.counts.mediaValidation[hit ? "hits" : "misses"] += 1;
    return hit;
  }

  rememberValidated(kind: string, contentSha256: string): void {
    if (this.validated.size >= VALIDATION_CACHE_MAX_ENTRIES) {
      const oldest = this.validated.values().next().value;
      if (oldest !== undefined) this.validated.delete(oldest);
    }
    this.validated.add(`${kind}:${contentSha256}`);
  }

  /** A source probe, copied so a caller cannot change what later renders see. */
  sourceProbe(identity: string | null): WorkerMediaInspection | undefined {
    const probe = identity ? this.probes.get(identity) : undefined;
    this.counts.sourceProbe[probe ? "hits" : "misses"] += 1;
    return probe ? structuredClone(probe) : undefined;
  }

  rememberSourceProbe(identity: string | null, probe: WorkerMediaInspection): void {
    if (!identity) return;
    if (this.probes.size >= SOURCE_PROBE_CACHE_MAX_ENTRIES && !this.probes.has(identity)) {
      const oldest = this.probes.keys().next().value;
      if (oldest !== undefined) this.probes.delete(oldest);
    }
    this.probes.set(identity, structuredClone(probe));
  }
}

/** Identity of one immutable source object, or null when its size is unknown. */
export function sourceProbeIdentity(
  storageKey: string,
  sizeBytes: number | null | undefined,
): string | null {
  return typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes > 0
    ? `${storageKey}#${sizeBytes}`
    : null;
}

/**
 * Runs `decode` unless these exact bytes already passed it as `kind`. A file that
 * cannot be read for hashing is simply decoded; a failed decode is never stored.
 */
export async function validateMediaOnce(input: {
  cache: Pick<RenderFactCache, "isValidated" | "rememberValidated">;
  filePath: string;
  kind: string;
  signal?: AbortSignal;
  /** Rethrows cancellation and ownership loss; anything else means "unreadable". */
  rethrowControl: (error: unknown) => void;
  decode: () => Promise<boolean>;
}): Promise<boolean> {
  let digest: string | null = null;
  try {
    digest = await contentSha256(input.filePath, input.signal);
  } catch (error) {
    input.rethrowControl(error);
  }
  if (digest && input.cache.isValidated(input.kind, digest)) return true;
  const valid = await input.decode();
  if (valid && digest) input.cache.rememberValidated(input.kind, digest);
  return valid;
}

export async function contentSha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The cache every render in this worker process shares. */
export const processRenderFactCache = new RenderFactCache();
