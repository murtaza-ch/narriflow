/**
 * Work-size deadlines and process-wide disk/backlog admission for clip renders.
 *
 * Everything here is policy from `RenderConfig` (spec: "Resource, temporary-file
 * and deadline policy"). The attempt asks three questions:
 *  - how long may this encode / transfer legitimately run? (`renderEncodeDeadlineMs`,
 *    `transferDeadlineMs`: finite at every input, never below the floor);
 *  - may I produce another output now? (`RenderResourceBudget.reserve`: waits for
 *    upload backlog room, then for free disk, and defers the attempt rather than
 *    failing a clip when space does not come back);
 *  - who still needs this file? (`ScratchFileRefs`: unlink at the last release).
 */
import { rm, statfs as nodeStatfs } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkflowFailure } from "@narriflow/services";
import type { RenderConfig } from "./render-config";

const MIB = 1024 * 1024;
const REFERENCE_PIXELS = 1920 * 1080;
/** A 4K frame costs about four 1080p frames to decode and scale. */
const MAX_PIXEL_WEIGHT = 4;
/** Tone mapping runs on float frames at source resolution (ticket 07). */
const HDR_WEIGHT = 3;
const ESTIMATED_OUTPUT_BYTES_PER_SEC = 2 * MIB;
const MIN_ESTIMATED_OUTPUT_BYTES = 16 * MIB;
const TRANSFER_SETUP_MS = 30_000;
const DISK_BACKOFF_START_MS = 1_000;
const DISK_BACKOFF_MAX_MS = 15_000;

type DeadlinePolicy = Pick<
  RenderConfig,
  "renderCommandTimeoutMs" | "renderDeadlineFloorMs" | "renderDeadlineRealtimeFactor"
>;
type TransferPolicy = Pick<
  RenderConfig,
  "transferDeadlineFloorMs" | "transferDeadlineCeilingMs" | "transferMinBytesPerSec"
>;
type DiskPolicy = Pick<
  RenderConfig,
  "diskMinFreeBytes" | "diskMinFreeFraction" | "scratchMaxBytes" | "scratchMaxVolumeFraction"
>;
type BacklogPolicy = Pick<RenderConfig, "uploadMaxWaitingJobs" | "uploadMaxWaitingBytes">;
export type RenderResourcePolicy = DeadlinePolicy &
  TransferPolicy &
  DiskPolicy &
  BacklogPolicy &
  Pick<RenderConfig, "diskAdmissionWaitMs">;

export interface EncodeWorkSize {
  editedDurationSec: number;
  sourceWidth: number | null;
  sourceHeight: number | null;
  hdr: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * clamp(factor x edited duration x resolution weight x HDR weight, floor, ceiling).
 * Unknown or non-finite work size is the ceiling: a deadline is never shorter
 * than a legitimately long render, and never longer than the configured ceiling.
 */
export function renderEncodeDeadlineMs(work: EncodeWorkSize, policy: DeadlinePolicy): number {
  const ceiling = policy.renderCommandTimeoutMs;
  const floor = Math.min(policy.renderDeadlineFloorMs, ceiling);
  if (!Number.isFinite(work.editedDurationSec) || work.editedDurationSec < 0) return ceiling;
  const pixels =
    work.sourceWidth && work.sourceHeight && work.sourceWidth > 0 && work.sourceHeight > 0
      ? work.sourceWidth * work.sourceHeight
      : REFERENCE_PIXELS;
  const pixelWeight = clamp(pixels / REFERENCE_PIXELS, 1, MAX_PIXEL_WEIGHT);
  const ms =
    work.editedDurationSec * 1000 * policy.renderDeadlineRealtimeFactor * pixelWeight * (work.hdr ? HDR_WEIGHT : 1);
  if (!Number.isFinite(ms)) return ceiling;
  return Math.ceil(clamp(ms, floor, ceiling));
}

/** clamp(30s + bytes / minimum rate, floor, ceiling). Unknown size is the ceiling. */
export function transferDeadlineMs(bytes: number | null | undefined, policy: TransferPolicy): number {
  const ceiling = policy.transferDeadlineCeilingMs;
  const floor = Math.min(policy.transferDeadlineFloorMs, ceiling);
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ceiling;
  return Math.ceil(clamp(TRANSFER_SETUP_MS + (bytes / policy.transferMinBytesPerSec) * 1000, floor, ceiling));
}

/** Conservative disk reservation for one encoded output (about twice a typical CRF 21 rate). */
export function estimateRenderOutputBytes(editedDurationSec: number): number {
  if (!Number.isFinite(editedDurationSec) || editedDurationSec < 0) return MIN_ESTIMATED_OUTPUT_BYTES;
  return Math.max(MIN_ESTIMATED_OUTPUT_BYTES, Math.ceil(editedDurationSec * ESTIMATED_OUTPUT_BYTES_PER_SEC));
}

// --- Disk facts and admission ------------------------------------------------

export interface DiskFacts {
  freeBytes: number;
  volumeBytes: number;
}
export type StatFsLike = (
  path: string,
) => Promise<{ bavail: number | bigint; bsize: number | bigint; blocks: number | bigint }>;

/** statfs of `path`, or of its nearest existing parent when the scratch path is not created yet. */
export async function readDiskFacts(path: string, statfs: StatFsLike = nodeStatfs): Promise<DiskFacts> {
  let candidate = path;
  for (;;) {
    try {
      const disk = await statfs(candidate);
      return {
        freeBytes: Number(disk.bavail) * Number(disk.bsize),
        volumeBytes: Number(disk.blocks) * Number(disk.bsize),
      };
    } catch (error) {
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** max(1GiB, 10% of the volume) by default. */
export function freeSpaceFloorBytes(policy: DiskPolicy, volumeBytes: number): number {
  return Math.max(policy.diskMinFreeBytes, Math.ceil(volumeBytes * policy.diskMinFreeFraction));
}

/** min(8GiB, 50% of the volume) by default. */
export function scratchLimitBytes(policy: DiskPolicy, volumeBytes: number): number {
  return Math.min(policy.scratchMaxBytes, Math.floor(volumeBytes * policy.scratchMaxVolumeFraction));
}

export type AdmissionVerdict = "admit" | "wait_disk_low" | "wait_scratch_full" | "never_fits";

/**
 * `outstandingBytes` is every other live reservation (not yet reflected in free
 * space). A request that alone exceeds the scratch limit can never be admitted;
 * unreadable volume facts never admit.
 */
export function judgeAdmission(
  policy: DiskPolicy,
  facts: DiskFacts,
  outstandingBytes: number,
  requestBytes: number,
): AdmissionVerdict {
  const { freeBytes, volumeBytes } = facts;
  if (!Number.isFinite(freeBytes) || !Number.isFinite(volumeBytes) || volumeBytes <= 0) return "wait_disk_low";
  if (requestBytes > scratchLimitBytes(policy, volumeBytes)) return "never_fits";
  if (outstandingBytes + requestBytes > scratchLimitBytes(policy, volumeBytes)) return "wait_scratch_full";
  if (freeBytes < freeSpaceFloorBytes(policy, volumeBytes) + outstandingBytes + requestBytes) return "wait_disk_low";
  return "admit";
}

/**
 * The attempt cannot start more work on this replica right now. Thrown before
 * any media work and never recorded against a clip: the attempt is released and
 * retried through the workflow's existing backoff.
 */
export class RenderResourceDeferral extends WorkflowFailure {
  constructor(
    code: "render_scratch_disk_low" | "render_scratch_limit_reached",
    message: string,
    readonly waitedMs: number,
  ) {
    super(code, "retryable", message);
    this.name = "RenderResourceDeferral";
  }
}

export interface BudgetEnvironment {
  statfs?: StatFsLike;
  nowMs(): number;
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
  signal?: AbortSignal;
}

export interface ReservationRequest {
  /** Directory whose volume must hold the bytes. */
  directory: string;
  bytes: number;
  /** An output counts against the upload backlog once `queued`; a source download never does. */
  kind: "source" | "output";
}

export interface RenderReservation {
  readonly bytes: number;
  /** The finished output is waiting for an upload slot (actual size replaces the estimate). */
  queued(actualBytes: number): void;
  /** An upload slot picked it up. */
  uploading(): void;
  release(): void;
}

export interface RenderResourceSnapshot {
  reservations: number;
  reservedBytes: number;
  waitingUploads: number;
  waitingUploadBytes: number;
  activeUploads: number;
  encoding: boolean;
  blockedProducers: number;
}

type ReservationState = "producing" | "waiting" | "uploading" | "released";

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Clip render cancelled", "AbortError");
}

export class RenderResourceBudget {
  private readonly reservations = new Set<{ state: ReservationState; bytes: number }>();
  private readonly waiters = new Set<() => void>();
  private encodes = 0;

  constructor(private readonly policy: RenderResourcePolicy) {}

  snapshot(): RenderResourceSnapshot {
    let reservedBytes = 0;
    let waitingUploads = 0;
    let waitingUploadBytes = 0;
    let activeUploads = 0;
    for (const reservation of this.reservations) {
      reservedBytes += reservation.bytes;
      if (reservation.state === "waiting") {
        waitingUploads += 1;
        waitingUploadBytes += reservation.bytes;
      }
      if (reservation.state === "uploading") activeUploads += 1;
    }
    return {
      reservations: this.reservations.size,
      reservedBytes,
      waitingUploads,
      waitingUploadBytes,
      activeUploads,
      encoding: this.encodes > 0,
      blockedProducers: this.waiters.size,
    };
  }

  /** Marks the replica's one full encode, so background CPU work can stay out of its way. */
  async trackEncode<T>(work: () => Promise<T>): Promise<T> {
    this.encodes += 1;
    try {
      return await work();
    } finally {
      this.encodes -= 1;
      this.notify();
    }
  }

  /**
   * Waits for upload-backlog room (outputs only), then for free disk. Returns a
   * reservation that must be released. Throws `RenderResourceDeferral` after the
   * configured wait, a plain retryable failure when the request can never fit,
   * and the abort reason when the attempt is cancelled while blocked.
   */
  async reserve(request: ReservationRequest, environment: BudgetEnvironment): Promise<RenderReservation> {
    const bytes = Math.max(0, Math.ceil(request.bytes));
    if (request.kind === "output") {
      await this.waitUntil(() => this.hasBacklogRoom(bytes), environment.signal);
    }
    const startedAtMs = environment.nowMs();
    let delayMs = DISK_BACKOFF_START_MS;
    for (;;) {
      environment.signal?.throwIfAborted();
      const facts = await readDiskFacts(request.directory, environment.statfs ?? nodeStatfs);
      environment.signal?.throwIfAborted();
      const verdict = judgeAdmission(this.policy, facts, this.reservedBytes(), bytes);
      if (verdict === "admit") return this.register(bytes);
      if (verdict === "never_fits") {
        throw new WorkflowFailure(
          "render_scratch_limit_exceeded",
          "retryable",
          "Required scratch bytes exceed the worker scratch limit",
        );
      }
      const waitedMs = environment.nowMs() - startedAtMs;
      if (waitedMs + delayMs > this.policy.diskAdmissionWaitMs) {
        throw new RenderResourceDeferral(
          verdict === "wait_disk_low" ? "render_scratch_disk_low" : "render_scratch_limit_reached",
          verdict === "wait_disk_low"
            ? "Insufficient scratch space to start render work"
            : "Worker scratch reservations are at their limit",
          waitedMs,
        );
      }
      await environment.sleep(delayMs, environment.signal);
      delayMs = Math.min(delayMs * 2, DISK_BACKOFF_MAX_MS);
    }
  }

  private reservedBytes(): number {
    let total = 0;
    for (const reservation of this.reservations) total += reservation.bytes;
    return total;
  }

  private hasBacklogRoom(bytes: number): boolean {
    // A single output larger than the waiting-bytes limit takes an exclusive slot.
    if (bytes > this.policy.uploadMaxWaitingBytes) return this.reservations.size === 0;
    const { waitingUploads, waitingUploadBytes } = this.snapshot();
    return (
      waitingUploads < this.policy.uploadMaxWaitingJobs &&
      waitingUploadBytes + bytes <= this.policy.uploadMaxWaitingBytes
    );
  }

  private register(bytes: number): RenderReservation {
    const record: { state: ReservationState; bytes: number } = { state: "producing", bytes };
    this.reservations.add(record);
    const transition = (from: ReservationState[], to: ReservationState) => {
      if (!from.includes(record.state)) return;
      record.state = to;
      this.notify();
    };
    return {
      get bytes() {
        return record.bytes;
      },
      queued: (actualBytes) => {
        if (record.state !== "producing") return;
        record.bytes = Math.max(0, Math.ceil(actualBytes));
        transition(["producing"], "waiting");
      },
      uploading: () => transition(["producing", "waiting"], "uploading"),
      release: () => {
        if (record.state === "released") return;
        record.state = "released";
        this.reservations.delete(record);
        this.notify();
      },
    };
  }

  private waitUntil(ready: () => boolean, signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!ready()) return;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      const cleanup = () => {
        this.waiters.delete(check);
        signal?.removeEventListener("abort", onAbort);
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }
}

const budgets = new WeakMap<object, RenderResourceBudget>();
/** One budget per frozen worker config: the ledger is process-wide, as the resources are. */
export function renderResourceBudgetFor(config: Readonly<RenderConfig>): RenderResourceBudget {
  let budget = budgets.get(config);
  if (!budget) {
    budget = new RenderResourceBudget(config);
    budgets.set(config, budget);
  }
  return budget;
}

// --- Reference-counted scratch files -----------------------------------------

/** Unlinks a file when its last holder releases it. An unlink failure is reported, never thrown. */
export class ScratchFileRefs {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly remove: (path: string) => Promise<void> = (path) => rm(path, { force: true }),
    private readonly onRemoveFailure: (path: string, error: unknown) => void = () => {},
  ) {}

  retain(path: string): void {
    this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
  }

  count(path: string): number {
    return this.counts.get(path) ?? 0;
  }

  async release(path: string): Promise<void> {
    const remaining = (this.counts.get(path) ?? 0) - 1;
    if (remaining > 0) {
      this.counts.set(path, remaining);
      return;
    }
    this.counts.delete(path);
    try {
      await this.remove(path);
    } catch (error) {
      this.onRemoveFailure(path, error);
    }
  }
}

// --- Transfer watchdog -------------------------------------------------------

export interface WatchdogClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface TransferWatchdog {
  /** Aborts when the deadline passes or the byte count stops growing; also follows `parent`. */
  readonly signal: AbortSignal;
  /** The typed timeout failure when the watchdog (not the parent) stopped the transfer. */
  failure(): WorkflowFailure | null;
  stop(): void;
}

/** Enforces the size-derived deadline and the no-progress bound on a download. */
export function startTransferWatchdog(input: {
  parent?: AbortSignal;
  deadlineMs: number;
  noProgressMs: number;
  pollMs?: number;
  measureBytes(): Promise<number>;
  clock: WatchdogClock;
  codePrefix: string;
}): TransferWatchdog {
  const controller = new AbortController();
  const { clock } = input;
  let failure: WorkflowFailure | null = null;
  let stopped = false;
  let lastBytes = -1;
  let lastProgressAtMs = clock.nowMs();
  const pollMs = input.pollMs ?? Math.max(250, Math.floor(input.noProgressMs / 4));

  const trip = (code: string, message: string) => {
    if (stopped || failure) return;
    failure = new WorkflowFailure(`${input.codePrefix}_${code}`, "retryable", message);
    controller.abort(failure);
  };
  const deadlineTimer = clock.setTimeout(() => trip("timeout", "Transfer exceeded its size-derived deadline"), input.deadlineMs);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const poll = () => {
    if (stopped || failure) return;
    input.measureBytes().then(
      (bytes) => {
        if (stopped || failure) return;
        const now = clock.nowMs();
        if (bytes !== lastBytes) {
          lastBytes = bytes;
          lastProgressAtMs = now;
        } else if (now - lastProgressAtMs >= input.noProgressMs) {
          trip("stalled", "Transfer made no progress");
          return;
        }
        pollTimer = clock.setTimeout(poll, pollMs);
      },
      () => {
        if (stopped || failure) return;
        // An unreadable size (file not created yet) is "no growth", not a failure.
        if (clock.nowMs() - lastProgressAtMs >= input.noProgressMs) {
          trip("stalled", "Transfer made no progress");
          return;
        }
        pollTimer = clock.setTimeout(poll, pollMs);
      },
    );
  };
  pollTimer = clock.setTimeout(poll, pollMs);
  const onParentAbort = () => {
    if (!failure) controller.abort(abortReason(input.parent));
  };
  input.parent?.addEventListener("abort", onParentAbort, { once: true });
  if (input.parent?.aborted) onParentAbort();

  return {
    signal: controller.signal,
    failure: () => failure,
    stop: () => {
      stopped = true;
      clock.clearTimeout(deadlineTimer);
      if (pollTimer !== undefined) clock.clearTimeout(pollTimer);
      input.parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
