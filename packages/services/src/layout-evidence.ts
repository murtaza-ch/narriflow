import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CLIP_AUTO_LAYOUT_ENGINE,
  CLIP_AUTO_LAYOUT_VERSION,
  clipAutoLayoutAnalysisSchema,
  getEffectiveClipTiming,
  type ClipAutoLayoutAnalysis,
  type EditorDocument,
  type SourceRange,
  type TranscriptUtterance,
} from "@narriflow/validators";
import { accessibleProjectWhere } from "./project-access";
import { decodeClipEditorDocumentFromStorage } from "./clip-editor-document-persistence";

/** A clip still missing a preview proxy, with enough of its project's
 *  source info for the worker to cut one. Returned by
 *  {@link LayoutEvidenceLifecycle.listPendingPreviews}.
 *
 *  `startSec`/`endSec` double as the EXPECTED window for
 *  {@link LayoutEvidenceLifecycle.completePreview}'s claim: the worker echoes them
 *  back on completion, and the claim only succeeds if the clip's stored
 *  boundaries still match. Without this, an in-flight cut for an OLD window
 *  can land after a boundary edit/reset already nulled `previewStorageKey`
 *  for a NEW window — the stale attempt would otherwise win the
 *  `previewStorageKey IS NULL` race and persist a proxy for the wrong
 *  window. */
export interface ClipPendingPreview {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  sourceStorageKey: string;
  sourceDurationSec: number | null;
  editorRevision: number;
}

/** A clip whose proxy exists but whose shared automatic speaker-layout plan
 * has not been analyzed yet (or was explicitly invalidated by a range edit). */
export interface ClipPendingAutoLayoutAnalysis {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  transcriptSlice: TranscriptUtterance[];
  deletedRanges: SourceRange[];
  editorRevision: number;
  previewStorageKey: string;
  previewStartSec: number;
  previewDurationSec: number;
  /** Per-attempt fencing token. Only the worker holding this token may
   * publish or defer the claimed analysis. */
  autoLayoutClaimToken: string;
  sourceStorageKey: string;
  leaseMs: number;
}

export class LayoutEvidenceClaimLost extends Error {
  constructor(readonly clipId: string) {
    super(`Layout evidence claim for ${clipId} is no longer owned`);
    this.name = "LayoutEvidenceClaimLost";
  }
}

interface LayoutEvidenceLifecycleDependencies {
  prisma: PrismaClient;
  now?: () => Date;
  scheduler?: {
    schedule(callback: () => void, intervalMs: number): unknown;
    cancel(handle: unknown): void;
  };
}

const autoLayoutEvidenceNeedsRefreshWhere = {
  OR: [
    { autoLayoutAnalysis: { equals: Prisma.DbNull } },
    {
      autoLayoutAnalysis: {
        path: ["version"],
        not: CLIP_AUTO_LAYOUT_VERSION,
      },
    },
    {
      autoLayoutAnalysis: {
        path: ["engine"],
        not: CLIP_AUTO_LAYOUT_ENGINE,
      },
    },
  ],
} satisfies Prisma.ClipWhereInput;

function autoLayoutClaimStateWhere(now: Date): Prisma.ClipWhereInput {
  return {
    OR: [
      {
        autoLayoutStatus: "pending",
        OR: [
          { autoLayoutLeaseExpiresAt: null },
          { autoLayoutLeaseExpiresAt: { lte: now } },
        ],
      },
      {
        autoLayoutStatus: "processing",
        autoLayoutLeaseExpiresAt: { lte: now },
      },
      { autoLayoutStatus: "completed" },
    ],
  };
}

/** Owns preview admission and background evidence claims. Workflow render
 * evidence remains fenced by its Workflow Attempt persistence adapter. */
export class LayoutEvidenceLifecycle {
  constructor(private readonly deps: LayoutEvidenceLifecycleDependencies) {}
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /**
   * Finds clips still missing a preview proxy, highest `viralityScore`
   * first (users look at the top clips first) — scoped to projects whose
   * source is still available and fully ingested. Backs the worker's
   * decoupled `processPendingClipPreviews` poll (apps/worker/src/tasks/
   * clip-preview.ts), which also backfills every pre-existing clip.
   *
   * Returns the *effective* (transcript-boundary-expanded) timing — the
   * exact same `getEffectiveClipTiming` computation `toClipSnapshot` uses
   * for what the studio/clip-card actually display — not the raw DB
   * columns. A freshly-detected clip's raw `startSec`/`endSec` can differ
   * from its displayed timing (boundary edits persist the effective values
   * back, but detection doesn't); padding around the raw columns could
   * leave the proxy not actually covering what's shown, silently reproducing
   * the exact off-by-`previewStartSec` desync this feature exists to avoid.
   */
  async listPendingPreviews(limit: number): Promise<ClipPendingPreview[]> {
    const prisma = this.deps.prisma;
    const take = Math.max(1, Math.min(25, limit));

    const clips = await prisma.clip.findMany({
      where: {
        previewStorageKey: null,
        project: {
          ...accessibleProjectWhere(this.now()),
          sourceStorageKey: { not: null },
          ingestStatus: "ready",
        },
      },
      orderBy: [{ viralityScore: "desc" }, { createdAt: "asc" }],
      take,
      select: {
        id: true,
        projectId: true,
        startSec: true,
        endSec: true,
        transcriptSlice: true,
        captionPreset: true,
        studioEdits: true,
        brollUrl: true,
        deletedRanges: true,
        editorDocumentVersion: true,
        sceneBlocks: true,
        censorSegments: true,
        mediaMotions: true,
        editorRevision: true,
        project: {
          select: { sourceStorageKey: true, sourceDurationSeconds: true },
        },
      },
    });

    const pending: ClipPendingPreview[] = [];
    for (const clip of clips) {
      if (!clip.project.sourceStorageKey) continue;

      // tailPadSec 0 — must stay in lockstep with toClipSnapshot (see its
      // comment): slice-only timing treats stored bounds as final.
      let document: EditorDocument;
      try {
        document = decodeClipEditorDocumentFromStorage(
          clip,
          clip.project.sourceDurationSeconds,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "clip_preview_document_skipped",
            clipId: clip.id,
            projectId: clip.projectId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      const effective = getEffectiveClipTiming({
        utterances: document.transcriptSlice,
        startSec: document.clipStartSec,
        endSec: document.clipEndSec,
        sourceDurationSec: clip.project.sourceDurationSeconds ?? null,
        tailPadSec: 0,
      });

      pending.push({
        id: clip.id,
        projectId: clip.projectId,
        startSec: effective.startSec,
        endSec: effective.endSec,
        sourceStorageKey: clip.project.sourceStorageKey,
        sourceDurationSec: clip.project.sourceDurationSeconds ?? null,
        editorRevision: clip.editorRevision,
      });
    }
    return pending;
  }

  /**
   * Persists a clip's generated preview-proxy metadata — but only if no
   * proxy has been recorded yet AND the clip's boundary window still
   * matches what this attempt cut its proxy for. `previewStorageKey IS
   * NULL` is the atomic claim condition (mirroring the codebase's
   * claim-via-conditional-update idiom used by Workflow Run claims),
   * since the Clip model has no separate "generating" status column to
   * transition: two workers racing to cut the same clip's proxy will both
   * upload, but only one write wins here — the loser (persisted: false)
   * must delete its own upload.
   *
   * The `startSec`/`endSec IS NULL`-adjacent window check closes a second,
   * narrower race than that one: an editor save/reset can null
   * `previewStorageKey` for a NEW window while an OLD-window cut is still
   * in flight from BEFORE that change. `previewStorageKey IS NULL` alone
   * would still be true after the reset, so the stale attempt would win the
   * claim and persist a proxy for a window the clip no longer has. Matching
   * the clip's CURRENT `startSec`/`endSec` against the caller-supplied
   * `expectedClipStartSec`/`expectedClipEndSec` (the window this attempt
   * was actually cutting for) makes that impossible — a boundary change
   * always fails this attempt's claim, exactly like `editorRevision`
   * mismatches fail the editor document's guarded writes.
   */
  async completePreview(
    clipId: string,
    input: {
      storageKey: string;
      startSec: number;
      durationSec: number;
      /** The clip's own boundary window this attempt cut its proxy for
       *  (`ClipPendingPreview.startSec/endSec` at dispatch time) — distinct
       *  from `startSec` above, which is the PADDED preview window persisted
       *  as `previewStartSec`. */
      expectedClipStartSec: number;
      expectedClipEndSec: number;
      expectedEditorRevision: number;
    },
  ): Promise<{ persisted: boolean; projectId: string | null }> {
    const prisma = this.deps.prisma;
    const PREVIEW_WINDOW_EPSILON_SEC = 0.001;

    const clip = await prisma.clip.findUnique({
      where: { id: clipId },
      select: { projectId: true },
    });
    if (!clip) {
      return { persisted: false, projectId: null };
    }

    const claim = await prisma.clip.updateMany({
      where: {
        id: clipId,
        project: accessibleProjectWhere(this.now()),
        previewStorageKey: null,
        editorRevision: input.expectedEditorRevision,
        startSec: {
          gte: input.expectedClipStartSec - PREVIEW_WINDOW_EPSILON_SEC,
          lte: input.expectedClipStartSec + PREVIEW_WINDOW_EPSILON_SEC,
        },
        endSec: {
          gte: input.expectedClipEndSec - PREVIEW_WINDOW_EPSILON_SEC,
          lte: input.expectedClipEndSec + PREVIEW_WINDOW_EPSILON_SEC,
        },
      },
      data: {
        previewStorageKey: input.storageKey,
        previewStartSec: input.startSec,
        previewDurationSec: input.durationSec,
      },
    });

    if (claim.count === 0) {
      return { persisted: false, projectId: clip.projectId };
    }

    return { persisted: true, projectId: clip.projectId };
  }

  /**
   * Atomically claims one clip for automatic layout analysis. A durable lease
   * (rather than an in-process mutex) prevents duplicate proxy downloads and
   * CPU detection when workers are horizontally scaled. Expired processing
   * claims are recoverable after a crash; the UUID token fences a stale owner
   * from completing or releasing a newer attempt.
   */
  async claimAutomatic(
    leaseMs: number,
  ): Promise<ClipPendingAutoLayoutAnalysis | null> {
    const prisma = this.deps.prisma;
    const now = this.now();
    const boundedLeaseMs = Math.max(30_000, Math.min(15 * 60_000, leaseMs));
    const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs);
    const clips = await prisma.clip.findMany({
      where: {
        previewStorageKey: { not: null },
        previewStartSec: { not: null },
        previewDurationSec: { not: null },
        project: {
          ...accessibleProjectWhere(now),
          sourceStorageKey: { not: null },
          ingestStatus: "ready",
        },
        AND: [
          autoLayoutEvidenceNeedsRefreshWhere,
          autoLayoutClaimStateWhere(now),
        ],
      },
      orderBy: [{ viralityScore: "desc" }, { createdAt: "asc" }],
      // Read a few candidates so a collision with another replica does not
      // turn this tick into a false empty result.
      take: 8,
      select: {
        id: true,
        projectId: true,
        startSec: true,
        endSec: true,
        transcriptSlice: true,
        captionPreset: true,
        studioEdits: true,
        brollUrl: true,
        deletedRanges: true,
        editorDocumentVersion: true,
        sceneBlocks: true,
        censorSegments: true,
        mediaMotions: true,
        editorRevision: true,
        previewStorageKey: true,
        previewStartSec: true,
        previewDurationSec: true,
        project: { select: { sourceDurationSeconds: true, sourceStorageKey: true } },
      },
    });

    for (const clip of clips) {
      if (
        !clip.previewStorageKey || !clip.project.sourceStorageKey ||
        clip.previewStartSec === null ||
        clip.previewDurationSec === null
      ) {
        continue;
      }
      let document: EditorDocument;
      try {
        document = decodeClipEditorDocumentFromStorage(
          clip,
          clip.project.sourceDurationSeconds,
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "clip_auto_layout_document_skipped",
            clipId: clip.id,
            projectId: clip.projectId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        continue;
      }
      const claimToken = randomUUID();
      const claim = await prisma.clip.updateMany({
        where: {
          id: clip.id,
          editorRevision: clip.editorRevision,
          previewStorageKey: clip.previewStorageKey,
          previewStartSec: clip.previewStartSec,
          previewDurationSec: clip.previewDurationSec,
          project: accessibleProjectWhere(now),
          AND: [
            autoLayoutEvidenceNeedsRefreshWhere,
            autoLayoutClaimStateWhere(now),
          ],
        },
        data: {
          autoLayoutAnalysis: Prisma.DbNull,
          autoLayoutStatus: "processing",
          autoLayoutClaimToken: claimToken,
          autoLayoutLeaseExpiresAt: leaseExpiresAt,
          autoLayoutAttemptCount: { increment: 1 },
        },
      });
      if (claim.count === 0) continue;

      return {
        id: clip.id,
        projectId: clip.projectId,
        startSec: document.clipStartSec,
        endSec: document.clipEndSec,
        transcriptSlice: document.transcriptSlice,
        deletedRanges: document.deletedRanges,
        editorRevision: clip.editorRevision,
        previewStorageKey: clip.previewStorageKey,
        previewStartSec: clip.previewStartSec,
        previewDurationSec: clip.previewDurationSec,
        autoLayoutClaimToken: claimToken,
        sourceStorageKey: clip.project.sourceStorageKey,
        leaseMs: boundedLeaseMs,
      };
    }
    return null;
  }

  /** Keeps one active background claim leased and cancels its IO when an
   * editor or another worker takes ownership. Shutdown releases it promptly. */
  async runAutomaticClaim<T>(
    claim: ClipPendingAutoLayoutAnalysis,
    handler: (context: { signal: AbortSignal }) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T | undefined> {
    const external = options.signal ?? new AbortController().signal;
    const ownership = new AbortController();
    const signal = AbortSignal.any([external, ownership.signal]);
    const scheduler = this.deps.scheduler ?? {
      schedule: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
      cancel: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    let pending: Promise<void> | undefined;
    const handle = scheduler.schedule(() => {
      if (signal.aborted || pending) return;
      pending = this.renewAutomatic(claim)
        .catch((error) => ownership.abort(error))
        .finally(() => { pending = undefined; });
    }, Math.floor(claim.leaseMs / 3));
    const stop = () => scheduler.cancel(handle);
    let release: Promise<unknown> | undefined;
    const releaseOnShutdown = () => {
      stop();
      release ??= this.deferAutomatic(claim.id, claim.autoLayoutClaimToken, this.now())
        .catch((error) => console.warn(JSON.stringify({
          level: "error", message: "layout_evidence_shutdown_release_failed",
          clipId: claim.id, error: error instanceof Error ? error.message : String(error),
        })));
    };
    signal.addEventListener("abort", stop, { once: true });
    external.addEventListener("abort", releaseOnShutdown, { once: true });
    try {
      if (external.aborted) return undefined;
      return await handler({ signal });
    } catch (error) {
      if (ownership.signal.aborted) throw ownership.signal.reason;
      if (external.aborted) return undefined;
      throw error;
    } finally {
      stop();
      signal.removeEventListener("abort", stop);
      external.removeEventListener("abort", releaseOnShutdown);
      if (pending) await pending;
      if (external.aborted) {
        releaseOnShutdown();
        await release;
      }
    }
  }

  private async renewAutomatic(claim: ClipPendingAutoLayoutAnalysis): Promise<void> {
    const now = this.now();
    const renewed = await this.deps.prisma.clip.updateMany({
      where: {
        id: claim.id,
        editorRevision: claim.editorRevision,
        previewStorageKey: claim.previewStorageKey,
        autoLayoutAnalysis: { equals: Prisma.DbNull },
        autoLayoutStatus: "processing",
        autoLayoutClaimToken: claim.autoLayoutClaimToken,
        autoLayoutLeaseExpiresAt: { gt: now },
        project: accessibleProjectWhere(now),
      },
      data: { autoLayoutLeaseExpiresAt: new Date(now.getTime() + claim.leaseMs) },
    });
    if (renewed.count !== 1) throw new LayoutEvidenceClaimLost(claim.id);
  }

  /** Complete a worker claim only if its fencing token and analyzed inputs
   * are still current. */
  async completeAutomatic(
    clipId: string,
    analysis: ClipAutoLayoutAnalysis,
    expected: {
      editorRevision: number;
      previewStorageKey: string;
      claimToken: string;
    },
  ): Promise<boolean> {
    const prisma = this.deps.prisma;
    const parsed = clipAutoLayoutAnalysisSchema.parse(analysis);
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        editorRevision: expected.editorRevision,
        previewStorageKey: expected.previewStorageKey,
        autoLayoutAnalysis: { equals: Prisma.DbNull },
        autoLayoutStatus: "processing",
        autoLayoutClaimToken: expected.claimToken,
        autoLayoutLeaseExpiresAt: { gt: this.now() },
        project: accessibleProjectWhere(this.now()),
      },
      data: {
        autoLayoutAnalysis: parsed as unknown as Prisma.InputJsonValue,
        autoLayoutStatus: "completed",
        autoLayoutClaimToken: null,
        autoLayoutLeaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  /** Persist retry backoff for a failed claim so another replica or process
   * restart cannot immediately repeat the same expensive failure. */
  async deferAutomatic(
    clipId: string,
    claimToken: string,
    retryAt: Date,
  ): Promise<boolean> {
    const prisma = this.deps.prisma;
    const result = await prisma.clip.updateMany({
      where: {
        id: clipId,
        autoLayoutAnalysis: { equals: Prisma.DbNull },
        autoLayoutStatus: "processing",
        autoLayoutClaimToken: claimToken,
        autoLayoutLeaseExpiresAt: { gt: this.now() },
      },
      data: {
        autoLayoutStatus: "pending",
        autoLayoutClaimToken: null,
        autoLayoutLeaseExpiresAt: retryAt,
      },
    });
    return result.count === 1;
  }

}
