"use client";

import {
  Box,
  Flex,
  Grid,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Input } from "@narriflow/ui/components/input";
import { Select } from "@narriflow/ui/components/select";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  assistedCopyViewSchema,
  bulkScheduleResultSchema,
  SOCIAL_PROVIDER_CAPABILITIES,
  thumbnailExtractionViewSchema,
  type AssistedCopyView,
  type ClipSnapshot,
  type SocialAccountSnapshot,
  type SocialPlatform,
} from "@narriflow/validators";
import {
  AlertTriangle,
  CalendarRange,
  Check,
  Clock3,
  Image as ImageIcon,
  LockKeyhole,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authenticatedRequestFailureMessage } from "@/lib/authenticated-request-browser";
import { restoreCampaignSelection } from "./campaign-selection";
import {
  assistedCopyIntentIsSettled,
  createPublishingPreparationBrowserIntents,
} from "./publishing-preparation-browser-intents";
import {
  buildPublishingSelection,
  campaignScheduleIdempotencyKey,
  mergePublishingBulkScheduleResult,
  publishingBulkItemLabel,
  releaseCampaignScheduleIdempotencyKey,
  resolvePublishingExport,
	thumbnailAssetEligibleForPlatform,
  thumbnailControlForPlatform,
  type PublishingBulkScheduleResult,
  type PublishingExportCandidate,
} from "./publishing-preparation-model";

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  youtube_shorts: "YouTube Shorts",
  instagram_reels: "Instagram Reels",
  facebook_reels: "Facebook Reels",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  x: "X",
};

const PROVIDER_DEFAULT_THUMBNAIL_VALUE = "provider_default";

type CopyContent = {
  caption: string;
  hashtags: string[];
  title: string | null;
};

type CopyDraft = AssistedCopyView;

type DraftRow = {
  busy: boolean;
  error: string | null;
  draft: CopyDraft | null;
};

type ThumbnailJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempts: number;
  errorCode: string | null;
  asset: { id: string; title: string; provenance: "extracted" } | null;
  platform?: SocialPlatform;
  exportVariantId?: string;
  sourceTimeMs?: number;
};

type VisualAsset = {
  id: string;
  title: string;
  kind: "image" | "video";
	contentType: string;
	sizeBytes: number;
  provenance: "uploaded" | "generated" | "extracted";
};

type ReviewWorkspace = {
  candidates: PublishingExportCandidate[];
};

function apiFailure(payload: unknown, fallback: string) {
  return authenticatedRequestFailureMessage(
    payload && typeof payload === "object" ? payload : {},
    typeof window === "undefined"
      ? "/home"
      : `${window.location.pathname}${window.location.search}`,
    fallback,
  );
}

function defaultStartDate() {
  const date = new Date(Date.now() + 24 * 60 * 60_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function rowLabel(clip: Pick<ClipSnapshot, "index" | "title">) {
  return clip.title?.trim() || `Clip ${clip.index + 1}`;
}

export function PublishingPreparationPanel({
  projectId,
  clips,
  accounts,
  workspaceTimezone,
  assistedCopyEnabled,
  thumbnailExtractionEnabled,
  bulkSchedulingEnabled,
}: {
  projectId: string;
  clips: ClipSnapshot[];
  accounts: SocialAccountSnapshot[];
  workspaceTimezone: string;
  assistedCopyEnabled: boolean;
  thumbnailExtractionEnabled: boolean;
  bulkSchedulingEnabled: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [platform, setPlatform] = useState<SocialPlatform>("tiktok");
  const [accountId, setAccountId] = useState("");
  const [campaignNote, setCampaignNote] = useState("");
  const [lockedTerms, setLockedTerms] = useState("");
  const [workspace, setWorkspace] = useState<ReviewWorkspace | null>(null);
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null);
  const [thumbnailJobs, setThumbnailJobs] = useState<Record<string, ThumbnailJob>>({});
  const [thumbnailHistoryError, setThumbnailHistoryError] = useState<string | null>(null);
  const [thumbnailAssetId, setThumbnailAssetId] = useState("");
  const [frameThumbnailMode, setFrameThumbnailMode] = useState<
    "provider_default" | "video_frame"
  >("provider_default");
  const [frameTimeSec, setFrameTimeSec] = useState("1");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("17:00");
  const [frequencyMinutes, setFrequencyMinutes] = useState("120");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] =
    useState<PublishingBulkScheduleResult | null>(null);
  const previousPlatformRef = useRef(platform);
  const savedDraftRequestRef = useRef(0);
  const thumbnailHistoryRequestRef = useRef(0);
  const thumbnailMutationEpochRef = useRef(new Map<string, number>());
  const thumbnailBusyClipIdsRef = useRef(new Set<string>());
  const [thumbnailBusyClipIds, setThumbnailBusyClipIds] = useState<Set<string>>(
    new Set(),
  );
  const previousBulkPreparationRef = useRef<string | null>(null);
  const currentBulkPreparationRef = useRef<string | null>(null);
  const previousThumbnailSelectionRef = useRef<string | null>(null);
  const browserIntentsRef = useRef<ReturnType<
    typeof createPublishingPreparationBrowserIntents
  > | null>(null);

  function browserIntents() {
    browserIntentsRef.current ??= createPublishingPreparationBrowserIntents({
      storage: window.sessionStorage,
      createId: () => crypto.randomUUID(),
    });
    return browserIntentsRef.current;
  }

  const invalidateThumbnailMutations = useCallback(() => {
    for (const [clipId, epoch] of thumbnailMutationEpochRef.current) {
      thumbnailMutationEpochRef.current.set(clipId, epoch + 1);
    }
    thumbnailBusyClipIdsRef.current.clear();
    setThumbnailBusyClipIds(new Set());
  }, []);

  const beginThumbnailMutation = useCallback((clipId: string) => {
    if (thumbnailBusyClipIdsRef.current.has(clipId)) return null;
    const epoch = (thumbnailMutationEpochRef.current.get(clipId) ?? 0) + 1;
    thumbnailMutationEpochRef.current.set(clipId, epoch);
    thumbnailBusyClipIdsRef.current.add(clipId);
    setThumbnailBusyClipIds(new Set(thumbnailBusyClipIdsRef.current));
    return epoch;
  }, []);

  const finishThumbnailMutation = useCallback(
    (clipId: string, epoch: number) => {
      if (thumbnailMutationEpochRef.current.get(clipId) !== epoch) return;
      thumbnailBusyClipIdsRef.current.delete(clipId);
      setThumbnailBusyClipIds(new Set(thumbnailBusyClipIdsRef.current));
    },
    [],
  );

  useEffect(() => {
    setSelectedIds(
      restoreCampaignSelection(
        window.sessionStorage,
        projectId,
        clips.map((clip) => clip.id),
      ),
    );
  }, [clips, projectId]);

  const selectedClips = useMemo(
    () => buildPublishingSelection(clips, selectedIds),
    [clips, selectedIds],
  );
  const platformAccounts = useMemo(
    () =>
      accounts.filter(
        (account) => account.platform === platform && account.status === "active",
      ),
    [accounts, platform],
  );
  const selectedAccount = platformAccounts.find((account) => account.id === accountId) ?? null;
  const thumbnailControl = thumbnailControlForPlatform(platform);

  useEffect(() => {
    setAccountId((current) =>
      platformAccounts.some((account) => account.id === current)
        ? current
        : (platformAccounts[0]?.id ?? ""),
    );
  }, [platformAccounts]);

  useEffect(() => {
    if (previousPlatformRef.current === platform) return;
    previousPlatformRef.current = platform;
    setDrafts({});
    invalidateThumbnailMutations();
    setThumbnailJobs({});
    setThumbnailAssetId("");
    setFrameThumbnailMode("provider_default");
    setBulkResult(null);
    setBulkError(null);
    setDraftLoadError(null);
    setThumbnailHistoryError(null);
  }, [invalidateThumbnailMutations, platform]);

  const loadSavedDrafts = useCallback(async () => {
    const requestId = savedDraftRequestRef.current + 1;
    savedDraftRequestRef.current = requestId;
    setDraftLoadError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/assisted-copy?platform=${encodeURIComponent(platform)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        drafts?: CopyDraft[];
      };
      if (!response.ok) {
        throw new Error(apiFailure(payload, "Saved copy drafts could not be loaded."));
      }
      if (savedDraftRequestRef.current !== requestId) return;
      const hydrated = Object.fromEntries(
        (payload.drafts ?? []).map((draft) => [
          draft.clipId,
          { busy: false, error: null, draft } satisfies DraftRow,
        ]),
      );
      setDrafts((current) => ({
        ...hydrated,
        ...Object.fromEntries(
          Object.entries(current).filter(([, row]) => row.busy),
        ),
      }));
    } catch (error) {
      if (savedDraftRequestRef.current === requestId) {
        setDraftLoadError(
          error instanceof Error
            ? error.message
            : "Saved copy drafts could not be loaded.",
        );
      }
    }
  }, [platform, projectId]);

  useEffect(() => {
    void loadSavedDrafts();
    return () => {
      savedDraftRequestRef.current += 1;
    };
  }, [loadSavedDrafts]);

  const loadPreparation = useCallback(async () => {
    setLoadError(null);
    const [reviewResponse, assetsResponse] = await Promise.all([
      fetch(`/api/projects/${projectId}/review-rounds`, { cache: "no-store" }),
      fetch("/api/visual-assets", { cache: "no-store" }),
    ]);
    const reviewPayload = (await reviewResponse.json().catch(() => ({}))) as unknown;
    if (!reviewResponse.ok) {
      throw new Error(apiFailure(reviewPayload, "Exact exports could not be loaded."));
    }
    const assetPayload = (await assetsResponse.json().catch(() => ({}))) as {
      assets?: VisualAsset[];
    };
    setWorkspace(reviewPayload as ReviewWorkspace);
    if (assetsResponse.ok && Array.isArray(assetPayload.assets)) {
      setAssets(assetPayload.assets);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void loadPreparation()
      .catch((error) => {
        if (active) {
          setLoadError(
            error instanceof Error ? error.message : "Campaign preparation could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadPreparation]);

  const prepared = useMemo(
    () =>
      selectedClips.map((clip) => ({
        clip,
        export: resolvePublishingExport({
          clip,
          platform,
          candidates: workspace?.candidates ?? [],
        }),
      })),
    [platform, selectedClips, workspace],
  );
  const eligible = useMemo(
    () =>
      prepared.filter(
        (
          item,
        ): item is typeof item & {
          export: Extract<typeof item.export, { kind: "ready" }>;
        } => item.export.kind === "ready",
      ),
    [prepared],
  );
  const attention = useMemo(
    () => prepared.filter((item) => item.export.kind === "attention"),
    [prepared],
  );
  const thumbnailSelectionFingerprint = eligible
    .map((item) => `${item.clip.id}:${item.export.exportVariantId}`)
    .join("|");

  useEffect(() => {
    if (previousThumbnailSelectionRef.current === null) {
      previousThumbnailSelectionRef.current = thumbnailSelectionFingerprint;
      return;
    }
    if (
      previousThumbnailSelectionRef.current === thumbnailSelectionFingerprint
    ) {
      return;
    }
    previousThumbnailSelectionRef.current = thumbnailSelectionFingerprint;
    thumbnailHistoryRequestRef.current += 1;
    invalidateThumbnailMutations();
    setThumbnailJobs({});
    setFrameThumbnailMode("provider_default");
  }, [invalidateThumbnailMutations, thumbnailSelectionFingerprint]);

  useEffect(() => {
    if (thumbnailControl !== "video_frame" || eligible.length === 0) return;
    const requestId = thumbnailHistoryRequestRef.current + 1;
    thumbnailHistoryRequestRef.current = requestId;
    let active = true;
    setThumbnailHistoryError(null);
    const exportVariantIds = eligible.map(
      (item) => item.export.exportVariantId,
    );
    const query = new URLSearchParams({
      platform,
      exportVariantIds: exportVariantIds.join(","),
    });
    void fetch(
      `/api/projects/${projectId}/thumbnail-extractions?${query.toString()}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            apiFailure(payload, "Prepared thumbnails could not be loaded."),
          );
        }
        if (
          !active ||
          thumbnailHistoryRequestRef.current !== requestId
        ) return;
        const parsedJobs = thumbnailExtractionViewSchema.array().safeParse(
          payload && typeof payload === "object" && "jobs" in payload
            ? payload.jobs
            : undefined,
        );
        if (!parsedJobs.success) {
          throw new Error("Prepared thumbnail history was incomplete.");
        }
        const clipIdByVariant = new Map(
          eligible.map((item) => [
            item.export.exportVariantId,
            item.clip.id,
          ]),
        );
        const hydrated = Object.fromEntries(
          parsedJobs.data.flatMap((job) => {
            const clipId = clipIdByVariant.get(job.exportVariantId);
            return clipId ? [[clipId, job]] : [];
          }),
        );
        setThumbnailJobs(hydrated);
        if (Object.keys(hydrated).length > 0) {
          setFrameThumbnailMode("video_frame");
        }
      })
      .catch((error) => {
        if (
          active &&
          thumbnailHistoryRequestRef.current === requestId
        ) {
          setThumbnailHistoryError(
            error instanceof Error
              ? error.message
              : "Prepared thumbnails could not be loaded.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [eligible, platform, projectId, thumbnailControl]);

  const imageAssets = assets.filter(
    (asset) =>
      thumbnailAssetEligibleForPlatform(platform, asset) &&
      (asset.provenance === "uploaded" || asset.provenance === "generated"),
  );

  const updateDraft = useCallback((clipId: string, update: (row: DraftRow) => DraftRow) => {
    setDrafts((current) => ({
      ...current,
      [clipId]: update(
        current[clipId] ?? { busy: false, error: null, draft: null },
      ),
    }));
  }, []);

  async function generateForClip(clipId: string, sourceDraftId?: string) {
    if (!assistedCopyEnabled) return;
    const request = {
      clipId,
      platform,
      campaignNote: campaignNote.trim(),
      lockedTerms: lockedTerms
        .split(/[\n,]+/)
        .map((term) => term.trim())
        .filter(Boolean),
      ...(sourceDraftId ? { sourceDraftId } : {}),
    };
    const intent = browserIntents().assistedCopy(
      projectId,
      clipId,
      request,
    );
    updateDraft(clipId, (row) => ({ ...row, busy: true, error: null }));
    try {
      const response = await fetch(`/api/projects/${projectId}/assisted-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          idempotencyKey: intent.idempotencyKey,
        }),
      });
      const rawPayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiFailure(rawPayload, "Copy could not be generated."));
      }
      const parsed = assistedCopyViewSchema.safeParse(rawPayload);
      if (
        !parsed.success ||
        parsed.data.clipId !== clipId ||
        parsed.data.platform !== platform ||
        parsed.data.sourceDraftId !== (sourceDraftId ?? null)
      ) {
        throw new Error(
          "Copy generation response was incomplete. Retry to reconcile the same request.",
        );
      }
      const payload = parsed.data;
      if (assistedCopyIntentIsSettled(payload.status)) intent.confirm();
      if (payload.status !== "completed" || !payload.content) {
        throw new Error(payload.errorCode || "Copy generation did not produce a reviewable draft.");
      }
      updateDraft(clipId, () => ({ busy: false, error: null, draft: payload }));
    } catch (error) {
      updateDraft(clipId, (row) => ({
        ...row,
        busy: false,
        error: error instanceof Error ? error.message : "Copy could not be generated.",
      }));
    }
  }

  async function generateAll() {
    if (!campaignNote.trim()) return;
    for (const item of eligible) {
      await generateForClip(item.clip.id, drafts[item.clip.id]?.draft?.id);
    }
  }

  function editContent(clipId: string, content: CopyContent) {
    if (!assistedCopyEnabled) return;
    updateDraft(clipId, (row) =>
      row.draft
        ? { ...row, draft: { ...row.draft, content, confirmed: false } }
        : row,
    );
  }

  async function confirmDraft(clipId: string) {
    if (!assistedCopyEnabled) return;
    const row = drafts[clipId];
    if (!row?.draft?.content || row.busy) return;
    updateDraft(clipId, (current) => ({ ...current, busy: true, error: null }));
    try {
      const response = await fetch(
        `/api/projects/${projectId}/assisted-copy/${row.draft.id}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: row.draft.revision,
            content: row.draft.content,
          }),
        },
      );
      const rawPayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiFailure(rawPayload, "Copy could not be confirmed."));
      }
      const parsed = assistedCopyViewSchema.safeParse(rawPayload);
      if (!parsed.success) {
        throw new Error("Copy confirmation response was incomplete.");
      }
      updateDraft(clipId, () => ({
        busy: false,
        error: null,
        draft: parsed.data,
      }));
    } catch (error) {
      updateDraft(clipId, (current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "Copy could not be confirmed.",
      }));
    }
  }

  async function requestFrames() {
    if (
      !assistedCopyEnabled ||
      !thumbnailExtractionEnabled ||
      frameThumbnailMode !== "video_frame" ||
      thumbnailBusyClipIdsRef.current.size > 0 ||
      Object.values(thumbnailJobs).some(
        (job) => job.status === "queued" || job.status === "processing",
      )
    ) return;
    const sourceTimeSec = Number(frameTimeSec);
    if (!Number.isFinite(sourceTimeSec) || sourceTimeSec < 0) return;
    thumbnailHistoryRequestRef.current += 1;
    const operations = eligible.flatMap((item) => {
      const epoch = beginThumbnailMutation(item.clip.id);
      return epoch === null ? [] : [{ item, epoch }];
    });
    setThumbnailJobs((current) => ({
      ...current,
      ...Object.fromEntries(
        operations.map(({ item }) => [
          item.clip.id,
          {
            id: "",
            status: "queued" as const,
            attempts: 0,
            errorCode: null,
            asset: null,
            platform,
            exportVariantId: item.export.exportVariantId,
            sourceTimeMs: Math.round(sourceTimeSec * 1_000),
          },
        ]),
      ),
    }));
    for (const { item, epoch } of operations) {
      try {
        const request = {
          platform,
          exportVariantId: item.export.exportVariantId,
          sourceTimeSec,
          title: `${rowLabel(item.clip)} thumbnail`,
        };
        const intent = browserIntents().thumbnail(
          projectId,
          item.export.exportVariantId,
          request,
        );
        const response = await fetch(`/api/projects/${projectId}/thumbnail-extractions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...request,
            idempotencyKey: intent.idempotencyKey,
          }),
        });
        const rawPayload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            apiFailure(rawPayload, "Frame extraction could not start."),
          );
        }
        const parsed = thumbnailExtractionViewSchema.safeParse(rawPayload);
        if (
          !parsed.success ||
          parsed.data.platform !== platform ||
          parsed.data.exportVariantId !== item.export.exportVariantId ||
          parsed.data.sourceTimeMs !== Math.round(sourceTimeSec * 1_000)
        ) {
          throw new Error(
            "Frame extraction response was incomplete. Retry to reconcile the same request.",
          );
        }
        if (
          thumbnailMutationEpochRef.current.get(item.clip.id) === epoch
        ) {
          setThumbnailJobs((current) => ({
            ...current,
            [item.clip.id]: parsed.data,
          }));
        }
      } catch (error) {
        if (
          thumbnailMutationEpochRef.current.get(item.clip.id) === epoch
        ) {
          setThumbnailJobs((current) => ({
            ...current,
            [item.clip.id]: {
              id: "",
              status: "failed",
              attempts: 0,
              errorCode:
                error instanceof Error
                  ? error.message
                  : "Frame extraction could not start.",
              asset: null,
              platform,
              exportVariantId: item.export.exportVariantId,
              sourceTimeMs: Math.round(sourceTimeSec * 1_000),
            },
          }));
        }
      } finally {
        finishThumbnailMutation(item.clip.id, epoch);
      }
    }
  }

  useEffect(() => {
    const pending = Object.entries(thumbnailJobs)
      .filter(
        ([, job]) =>
          job.id && (job.status === "queued" || job.status === "processing"),
      )
      .map(([clipId, job]) => ({
        clipId,
        job,
        epoch: thumbnailMutationEpochRef.current.get(clipId) ?? 0,
      }));
    if (pending.length === 0) return;
    let stopped = false;
    const timer = window.setTimeout(async () => {
      const updates = await Promise.all(
        pending.map(async ({ clipId, job, epoch }) => {
          try {
            const response = await fetch(
              `/api/projects/${projectId}/thumbnail-extractions/${job.id}`,
              { cache: "no-store" },
            );
            const rawPayload = await response.json().catch(() => ({}));
            const parsed = thumbnailExtractionViewSchema.safeParse(rawPayload);
            return {
              clipId,
              epoch,
              job:
                response.ok &&
                parsed.success &&
                parsed.data.id === job.id &&
                parsed.data.exportVariantId === job.exportVariantId &&
                parsed.data.platform === job.platform &&
                parsed.data.sourceTimeMs === job.sourceTimeMs
                  ? parsed.data
                  : job,
            };
          } catch {
            return { clipId, epoch, job };
          }
        }),
      );
      if (!stopped) {
        setThumbnailJobs((current) => {
          const next = { ...current };
          for (const update of updates) {
            if (
              thumbnailMutationEpochRef.current.get(update.clipId) ===
                update.epoch &&
              !thumbnailBusyClipIdsRef.current.has(update.clipId)
            ) {
              next[update.clipId] = update.job;
            }
          }
          return next;
        });
      }
    }, 1_500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [projectId, thumbnailJobs]);

  async function retryThumbnail(clipId: string, job: ThumbnailJob) {
    if (
      !assistedCopyEnabled ||
      !thumbnailExtractionEnabled ||
      !job.id ||
      thumbnailBusyClipIdsRef.current.size > 0
    ) return;
    const epoch = beginThumbnailMutation(clipId);
    if (epoch === null) return;
    try {
      const response = await fetch(
        `/api/projects/${projectId}/thumbnail-extractions/${job.id}/retry`,
        { method: "POST" },
      );
      const rawPayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          apiFailure(rawPayload, "Frame extraction could not be retried."),
        );
      }
      const parsed = thumbnailExtractionViewSchema.safeParse(rawPayload);
      if (
        !parsed.success ||
        parsed.data.id !== job.id ||
        (job.platform !== undefined && parsed.data.platform !== job.platform) ||
        (job.exportVariantId !== undefined &&
          parsed.data.exportVariantId !== job.exportVariantId) ||
        (job.sourceTimeMs !== undefined &&
          parsed.data.sourceTimeMs !== job.sourceTimeMs)
      ) {
        throw new Error("Frame extraction retry response was incomplete.");
      }
      if (thumbnailMutationEpochRef.current.get(clipId) === epoch) {
        setThumbnailJobs((current) => ({
          ...current,
          [clipId]: parsed.data,
        }));
      }
    } catch (error) {
      if (thumbnailMutationEpochRef.current.get(clipId) === epoch) {
        setThumbnailJobs((current) => ({
          ...current,
          [clipId]: {
            ...job,
            errorCode:
              error instanceof Error
                ? error.message
                : "Frame extraction could not be retried.",
          },
        }));
      }
    } finally {
      finishThumbnailMutation(clipId, epoch);
    }
  }

  const thumbnailControlsBusy =
    thumbnailBusyClipIds.size > 0 ||
    Object.values(thumbnailJobs).some(
      (job) => job.status === "queued" || job.status === "processing",
    );

  const failedItemKeys = new Set(
    bulkResult?.items
      .filter((item) => item.status === "failed")
      .map((item) => item.itemKey) ?? [],
  );
  const campaignItems = bulkResult
    ? eligible.filter((item) => failedItemKeys.has(item.clip.id))
    : eligible;
  const occurrenceIndexByClipId = new Map(
    eligible.map((item, index) => [item.clip.id, index]),
  );
  const confirmedCampaignItems = campaignItems.filter(
    (item) => drafts[item.clip.id]?.draft?.confirmed,
  );
  const frameAssetsReady =
    thumbnailControl !== "video_frame" ||
    frameThumbnailMode === "provider_default" ||
    campaignItems.every((item) => thumbnailJobs[item.clip.id]?.asset?.id);
  const canSchedule =
    assistedCopyEnabled &&
    bulkSchedulingEnabled &&
    selectedAccount !== null &&
    campaignItems.length > 0 &&
    attention.length === 0 &&
    confirmedCampaignItems.length === campaignItems.length &&
    frameAssetsReady;
  const bulkPreparationFingerprint = JSON.stringify({
    projectId,
    platform,
    workspaceTimezone,
    accountId,
    startDate,
    windowStart,
    windowEnd,
    frequencyMinutes,
    thumbnailAssetId,
    frameThumbnailMode,
    items: eligible.map((item) => ({
      clipId: item.clip.id,
      editorRevision: item.clip.editorRevision,
      exportVariantId: item.export.exportVariantId,
      draftId: drafts[item.clip.id]?.draft?.id ?? null,
      draftRevision: drafts[item.clip.id]?.draft?.revision ?? null,
      confirmed: drafts[item.clip.id]?.draft?.confirmed ?? false,
      extractedAssetId: thumbnailJobs[item.clip.id]?.asset?.id ?? null,
    })),
  });
  currentBulkPreparationRef.current = bulkPreparationFingerprint;

  useEffect(() => {
    if (previousBulkPreparationRef.current === null) {
      previousBulkPreparationRef.current = bulkPreparationFingerprint;
      return;
    }
    if (previousBulkPreparationRef.current === bulkPreparationFingerprint) return;
    previousBulkPreparationRef.current = bulkPreparationFingerprint;
    setBulkResult(null);
    setBulkError(null);
  }, [bulkPreparationFingerprint]);

  async function scheduleCampaign() {
    if (!canSchedule || !selectedAccount || bulkBusy) return;
    const requestedPreparation = bulkPreparationFingerprint;
    setBulkBusy(true);
    setBulkError(null);
    const items = campaignItems.map((item) => {
      const draft = drafts[item.clip.id]!.draft!;
      const extractedAssetId = thumbnailJobs[item.clip.id]?.asset?.id ?? null;
      return {
        itemKey: item.clip.id,
        occurrenceIndex: occurrenceIndexByClipId.get(item.clip.id)!,
        clipId: item.clip.id,
        expectedEditorRevision: item.clip.editorRevision,
        exportVariantId: item.export.exportVariantId,
        accountId: selectedAccount.id,
        platform,
        assistedCopyDraftId: draft.id,
        assistedCopyRevision: draft.revision,
        aspectRatio: item.export.aspectRatio,
        resolution: item.export.resolution,
		durationSec: item.export.durationSec!,
        thumbnailAssetId:
          thumbnailControl === "custom_image"
            ? thumbnailAssetId || null
            : thumbnailControl === "video_frame" &&
                frameThumbnailMode === "video_frame"
              ? extractedAssetId
              : null,
      };
    });
    const intent = {
      timezone: workspaceTimezone,
      startDate,
      postingWindow: {
        startTime: windowStart,
        endTime: windowEnd,
        frequencyMinutes: Number(frequencyMinutes),
      },
      items,
    };
    const idempotencyKey = campaignScheduleIdempotencyKey(
      window.sessionStorage,
      projectId,
      intent,
      () => crypto.randomUUID(),
    );
    try {
      const response = await fetch(`/api/projects/${projectId}/bulk-schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey, ...intent }),
      });
      const rawPayload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(apiFailure(rawPayload, "Campaign could not be scheduled."));
      }
      const parsed = bulkScheduleResultSchema.safeParse(rawPayload);
      const expectedItems = new Map(
        items.map((item) => [
          item.itemKey,
          { clipId: item.clipId, accountId: item.accountId },
        ]),
      );
      if (
        !parsed.success ||
        parsed.data.items.length !== items.length ||
        parsed.data.items.some((item) => {
          const expected = expectedItems.get(item.itemKey);
          return (
            !expected ||
            expected.clipId !== item.clipId ||
            expected.accountId !== item.accountId
          );
        })
      ) {
        throw new Error(
          "Campaign scheduling response was incomplete. Retry to reconcile the same request.",
        );
      }
      if (currentBulkPreparationRef.current !== requestedPreparation) {
        throw new Error(
          "Campaign scheduling completed for earlier settings. Restore them or refresh before scheduling again.",
        );
      }
      const payload = parsed.data;
      releaseCampaignScheduleIdempotencyKey(window.sessionStorage, projectId);
      setBulkResult((current) =>
        mergePublishingBulkScheduleResult(current, payload),
      );
    } catch (error) {
      setBulkError(
        error instanceof Error ? error.message : "Campaign could not be scheduled.",
      );
    } finally {
      setBulkBusy(false);
    }
  }

  if (loading) {
    return (
      <Flex layerStyle="band" align="center" gap="2" minH="96px">
        <Spinner size="xs" />
        <Text fontSize="sm" color="fg.muted">Loading campaign preparation…</Text>
      </Flex>
    );
  }

  return (
    <Box layerStyle="band" mb="6" id="campaign-preparation">
      <Stack gap="5">
        <Flex justify="space-between" align={{ base: "flex-start", md: "center" }} gap="4" direction={{ base: "column", md: "row" }}>
          <Box>
            <Text textStyle="eyebrow" color="fg.subtle">Campaign preparation</Text>
            <Text textStyle="title" fontSize="lg" mt="1">
              {assistedCopyEnabled
                ? "Approve the words, then place the campaign"
                : "Saved campaign copy"}
            </Text>
            <Text fontSize="xs" color="fg.muted" mt="1" maxW="680px">
              {assistedCopyEnabled
                ? "Every row binds the current editor revision to one immutable export. Generated copy stays a draft until you confirm it."
                : "Drafts remain available after a plan or workspace access change. Their saved wording and confirmation state cannot be changed here."}
            </Text>
          </Box>
          <Flex align="center" gap="2" flexShrink="0">
            <Text textStyle="data" fontSize="12px" color="fg.subtle">{selectedClips.length}/100 selected</Text>
            <Button size="xs" variant="outline" asChild>
              <Link href={`/projects/${projectId}?tab=clips`}>Change selection</Link>
            </Button>
          </Flex>
        </Flex>

        {loadError ? (
          <Flex role="alert" align="center" gap="2" color="danger.fg">
            <AlertTriangle size={14} />
            <Text fontSize="xs">{loadError}</Text>
            <Button size="xs" variant="ghost" onClick={() => void loadPreparation()}><RefreshCw size={12} /> Recheck</Button>
          </Flex>
        ) : null}

        {selectedClips.length === 0 ? (
          <EmptyState
            title="Select campaign clips first"
            description="Choose the clips on the Clips tab, then use Schedule selected. Your selection survives the trip here."
          />
        ) : (
          <>
            <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) minmax(0, 1fr)" }} gap="4">
              <Stack gap="3" layerStyle="well" p="4">
                <Flex align="center" gap="2">
                  <Box textStyle="data" color="accent.fg">01</Box>
                  <Text textStyle="title" fontSize="sm">Destination and exact exports</Text>
                </Flex>
                <Grid
                  templateColumns={{
                    base: "1fr",
                    sm: assistedCopyEnabled ? "1fr 1fr" : "1fr",
                  }}
                  gap="3"
                >
                  <Box>
                    <Text textStyle="eyebrow" color="fg.subtle" mb="1">Platform</Text>
                    <Select
                      ariaLabel="Campaign platform"
                      size="sm"
                      value={platform}
                      onValueChange={(value) => setPlatform(value as SocialPlatform)}
                      disabled={
                        bulkBusy ||
                        thumbnailControlsBusy ||
                        Object.values(drafts).some((row) => row.busy)
                      }
                      items={(Object.keys(PLATFORM_LABELS) as SocialPlatform[]).map((value) => ({ value, label: PLATFORM_LABELS[value] }))}
                    />
                  </Box>
                  {assistedCopyEnabled ? (
                    <Box>
                      <Text textStyle="eyebrow" color="fg.subtle" mb="1">Account</Text>
                      <Select
                        ariaLabel="Campaign account"
                        size="sm"
                        value={accountId}
                        onValueChange={setAccountId}
                        disabled={platformAccounts.length === 0}
                        placeholder="No active account"
                        items={platformAccounts.map((account) => ({
                          value: account.id,
                          label: `${account.displayName}${account.handle ? ` · ${account.handle}` : ""}`,
                        }))}
                      />
                    </Box>
                  ) : null}
                </Grid>
                <Flex justify="space-between" gap="3" borderTopWidth="1px" borderColor="border.subtle" pt="3">
                  <Text fontSize="xs" color="fg.muted">{eligible.length} exact export{eligible.length === 1 ? "" : "s"} ready</Text>
                  <Text fontSize="xs" color={attention.length ? "warning.fg" : "success.fg"}>{attention.length ? `${attention.length} need attention` : "All revisions match"}</Text>
                </Flex>
              </Stack>

              <Stack gap="3" layerStyle="well" p="4">
                <Flex align="center" gap="2">
                  <Box textStyle="data" color="accent.fg">02</Box>
                  <Text textStyle="title" fontSize="sm">Voice-guided copy</Text>
                </Flex>
                {assistedCopyEnabled ? (
                  <>
                    <Textarea
                      aria-label="Campaign note"
                      value={campaignNote}
                      onChange={(event) => setCampaignNote(event.target.value.slice(0, 2_000))}
                      placeholder="What should this campaign communicate? Add the offer, audience, and call to action."
                      rows={3}
                      maxLength={2_000}
                      borderColor="border.control"
                    />
                    <Input
                      aria-label="Locked terms"
                      size="sm"
                      value={lockedTerms}
                      onChange={(event) => setLockedTerms(event.target.value)}
                      placeholder="Terms to preserve on regeneration, comma separated"
                    />
                    <Flex justify="space-between" align="center" gap="3">
                      <Text fontSize="11px" color="fg.subtle">
                        {eligible.length} reviewable draft{eligible.length === 1 ? "" : "s"} will be generated; source text never enters analytics.
                      </Text>
                      <Button size="sm" variant="outline" disabled={!campaignNote.trim() || eligible.length === 0 || Object.values(drafts).some((row) => row.busy)} onClick={() => void generateAll()}>
                        <Sparkles size={13} /> Generate drafts
                      </Button>
                    </Flex>
                  </>
                ) : (
                  <Flex
                    role="status"
                    align="flex-start"
                    gap="2"
                    borderTopWidth="1px"
                    borderColor="border.subtle"
                    pt="3"
                    color="fg.muted"
                  >
                    <LockKeyhole size={14} />
                    <Text fontSize="xs">
                      Saved campaign copy is view-only. Generation, editing,
                      confirmation, thumbnails, and scheduling are unavailable
                      for this workspace.
                    </Text>
                  </Flex>
                )}
                {draftLoadError ? (
                  <Flex role="alert" align="center" gap="2" color="danger.fg">
                    <AlertTriangle size={13} />
                    <Text fontSize="xs">{draftLoadError}</Text>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void loadSavedDrafts()}
                    >
                      <RefreshCw size={11} /> Recheck
                    </Button>
                  </Flex>
                ) : null}
              </Stack>
            </Grid>

            <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
              {prepared.map(({ clip, export: resolved }) => {
                const row = drafts[clip.id];
                const content = row?.draft?.content;
                return (
                  <Box key={clip.id} position="relative" py="4" ps="4" borderBottomWidth="1px" borderColor="border.subtle">
                    <Box position="absolute" insetInlineStart="0" top="0" bottom="0" w="3px" bg={resolved.kind === "ready" ? row?.draft?.confirmed ? "success.solid" : "accent.solid" : "warning.solid"} />
                    <Flex justify="space-between" align="flex-start" gap="4" direction={{ base: "column", md: "row" }}>
                      <Box minW="160px">
                        <Text textStyle="title" fontSize="sm">{rowLabel(clip)}</Text>
                        <Text textStyle="data" fontSize="11px" color="fg.subtle">revision {clip.editorRevision}</Text>
                        {resolved.kind === "ready" ? (
                          <Text fontSize="11px" color="fg.muted">{resolved.aspectRatio} · {resolved.resolution}</Text>
                        ) : (
                          <Text fontSize="11px" color="warning.fg">{resolved.code.replaceAll("_", " ")}</Text>
                        )}
                      </Box>
                      {content ? (
                        <Stack gap="2" flex="1" maxW="760px">
                          {SOCIAL_PROVIDER_CAPABILITIES[platform].titleField ? (
                            <Input
                              size="sm"
                              aria-label={`${rowLabel(clip)} title`}
                              value={content.title ?? ""}
                              maxLength={300}
                              readOnly={!assistedCopyEnabled}
                              bg={!assistedCopyEnabled ? "bg.subtle" : undefined}
                              onChange={(event) => editContent(clip.id, { ...content, title: event.target.value || null })}
                            />
                          ) : null}
                          <Textarea
                            aria-label={`${rowLabel(clip)} caption`}
                            value={content.caption}
                            maxLength={SOCIAL_PROVIDER_CAPABILITIES[platform].textLimit}
                            rows={3}
                            borderColor="border.control"
                            readOnly={!assistedCopyEnabled}
                            bg={!assistedCopyEnabled ? "bg.subtle" : undefined}
                            onChange={(event) => editContent(clip.id, { ...content, caption: event.target.value })}
                          />
                          <Input
                            size="sm"
                            aria-label={`${rowLabel(clip)} hashtags`}
                            value={content.hashtags.map((tag) => `#${tag}`).join(" ")}
                            readOnly={!assistedCopyEnabled}
                            bg={!assistedCopyEnabled ? "bg.subtle" : undefined}
                            onChange={(event) => editContent(clip.id, {
                              ...content,
                              hashtags: event.target.value.split(/[\s,]+/).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean).slice(0, 30),
                            })}
                          />
                          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
                            <Flex align="center" gap="1.5" color={row.draft?.guidanceSkipped ? "warning.fg" : "fg.subtle"}>
                              {row.draft?.guidanceSkipped ? <AlertTriangle size={12} /> : <LockKeyhole size={12} />}
                              <Text fontSize="11px">{row.draft?.guidanceSkipped ? "Neutral voice used; profile guidance was unavailable" : "Frozen Brand Profile voice applied"}</Text>
                            </Flex>
                            {assistedCopyEnabled ? (
                              <Flex gap="2">
                                <Button size="xs" variant="ghost" disabled={row.busy} onClick={() => void generateForClip(clip.id, row.draft?.id)}><RefreshCw size={12} /> Regenerate</Button>
                                <Button size="xs" variant="outline" disabled={row.busy || row.draft?.confirmed || !content.caption.trim()} onClick={() => void confirmDraft(clip.id)}>
                                  {row.busy ? <Spinner size="xs" /> : <Check size={12} />}
                                  {row.draft?.confirmed ? "Confirmed" : "Confirm copy"}
                                </Button>
                              </Flex>
                            ) : (
                              <Text textStyle="eyebrow" color={row.draft?.confirmed ? "success.fg" : "fg.subtle"}>
                                {row.draft?.confirmed ? "Confirmed copy" : "Saved draft"}
                              </Text>
                            )}
                          </Flex>
                        </Stack>
                      ) : resolved.kind === "ready" ? (
                        <Text fontSize="xs" color="fg.muted">
                          {row?.busy
                            ? "Generating a reviewable draft…"
                            : assistedCopyEnabled
                              ? "Add campaign guidance, then generate this platform draft."
                              : "No saved draft exists for this clip and platform."}
                        </Text>
                      ) : (
                        assistedCopyEnabled ? (
                          <Button size="xs" variant="ghost" asChild><Link href={`/projects/${projectId}?tab=clips`}>Prepare export</Link></Button>
                        ) : (
                          <Text fontSize="xs" color="fg.muted">No matching export is available.</Text>
                        )
                      )}
                    </Flex>
                    {row?.error ? <Text mt="2" fontSize="xs" color="danger.fg" role="alert">{row.error}</Text> : null}
                  </Box>
                );
              })}
            </Stack>

            {!assistedCopyEnabled &&
            thumbnailControl === "video_frame" &&
            (Object.keys(thumbnailJobs).length > 0 || thumbnailHistoryError) ? (
              <Stack gap="3" layerStyle="well" p="4">
                <Flex align="center" gap="2">
                  <Box textStyle="data" color="accent.fg">03</Box>
                  <Text textStyle="title" fontSize="sm">
                    Prepared thumbnails
                  </Text>
                </Flex>
                {thumbnailHistoryError ? (
                  <Text role="alert" fontSize="xs" color="danger.fg">
                    {thumbnailHistoryError}
                  </Text>
                ) : null}
                <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
                  {eligible.map((item) => {
                    const job = thumbnailJobs[item.clip.id];
                    if (!job) return null;
                    return (
                      <Flex
                        key={item.clip.id}
                        justify="space-between"
                        align="center"
                        py="2"
                        borderBottomWidth="1px"
                        borderColor="border.subtle"
                        gap="3"
                      >
                        <Text fontSize="xs">{rowLabel(item.clip)}</Text>
                        <Text
                          textStyle="eyebrow"
                          color={
                            job.status === "failed"
                              ? "danger.fg"
                              : job.status === "completed"
                                ? "success.fg"
                                : "fg.subtle"
                          }
                        >
                          {job.status}
                        </Text>
                      </Flex>
                    );
                  })}
                </Stack>
              </Stack>
            ) : null}

            {assistedCopyEnabled ? (
              <>
                {thumbnailControl ? (
                  <Stack gap="3" layerStyle="well" p="4">
                <Flex align="center" gap="2">
                  <Box textStyle="data" color="accent.fg">03</Box>
                  <Text textStyle="title" fontSize="sm">Provider-supported thumbnail</Text>
                </Flex>
                {thumbnailHistoryError ? (
                  <Text role="alert" fontSize="xs" color="danger.fg">
                    {thumbnailHistoryError}
                  </Text>
                ) : null}
                {thumbnailControl === "custom_image" && thumbnailExtractionEnabled ? (
                  <Grid templateColumns={{ base: "1fr", md: "minmax(0, 1fr) auto" }} gap="3" alignItems="end">
                    <Box>
                      <Text textStyle="eyebrow" color="fg.subtle" mb="1">Uploaded or generated image</Text>
                      <Select
                        ariaLabel="Campaign thumbnail asset"
                        size="sm"
                        value={thumbnailAssetId || PROVIDER_DEFAULT_THUMBNAIL_VALUE}
                        onValueChange={(value) =>
                          setThumbnailAssetId(
                            value === PROVIDER_DEFAULT_THUMBNAIL_VALUE ? "" : value,
                          )
                        }
                        items={[
                          {
                            value: PROVIDER_DEFAULT_THUMBNAIL_VALUE,
                            label: "Use provider default",
                          },
                          ...imageAssets.map((asset) => ({
                            value: asset.id,
                            label: `${asset.title} · ${asset.provenance}`,
                          })),
                        ]}
                      />
                      {imageAssets.length === 0 ? (
                        <Text mt="1" fontSize="11px" color="fg.subtle">
                          Add an uploaded or generated image to use a custom thumbnail.
                        </Text>
                      ) : null}
                    </Box>
                    <Text fontSize="11px" color="fg.subtle">Only durable Visual Assets are stored—never signed URLs.</Text>
                  </Grid>
                ) : thumbnailControl === "custom_image" ? (
                  <Stack gap="1">
                    <Text fontSize="sm">Use provider default thumbnail</Text>
                    <Text fontSize="11px" color="fg.subtle">
                      Custom image thumbnails are available on Pro and Business.
                    </Text>
                  </Stack>
                ) : (
                  <Stack gap="3">
                    {thumbnailExtractionEnabled ? (
                      <Box maxW="320px">
                        <Text textStyle="eyebrow" color="fg.subtle" mb="1">Cover source</Text>
                        <Select
                          ariaLabel="Video thumbnail source"
                          size="sm"
                          value={frameThumbnailMode}
                          disabled={thumbnailControlsBusy}
                          onValueChange={(value) => {
                            if (value === "provider_default" || value === "video_frame") {
                              setFrameThumbnailMode(value);
                            }
                          }}
                          items={[
                            { value: "provider_default", label: "Use provider default (first frame)" },
                            { value: "video_frame", label: "Extract an exact frame" },
                          ]}
                        />
                      </Box>
                    ) : (
                      <Stack gap="1">
                        <Text fontSize="sm">Use provider default (first frame)</Text>
                        <Text fontSize="11px" color="fg.subtle">
                          Exact-frame extraction is available on Pro and Business.
                        </Text>
                      </Stack>
                    )}
                    {thumbnailExtractionEnabled && frameThumbnailMode === "video_frame" ? (
                      <>
                        <Flex align="end" gap="3" wrap="wrap">
                          <Box maxW="180px">
                            <Text textStyle="eyebrow" color="fg.subtle" mb="1">Frame time</Text>
                            <Input size="sm" type="number" min="0" step="0.1" value={frameTimeSec} disabled={thumbnailControlsBusy} onChange={(event) => setFrameTimeSec(event.target.value)} />
                          </Box>
                          <Button size="sm" variant="outline" disabled={eligible.length === 0 || thumbnailControlsBusy} onClick={() => void requestFrames()}><ImageIcon size={13} /> Extract exact frames</Button>
                        </Flex>
                        <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
                          {eligible.map((item) => {
                            const job = thumbnailJobs[item.clip.id];
                            return (
                              <Flex key={item.clip.id} justify="space-between" align="center" py="2" borderBottomWidth="1px" borderColor="border.subtle" gap="3">
                                <Text fontSize="xs">{rowLabel(item.clip)}</Text>
                                <Flex align="center" gap="2">
                                  {job && (job.status === "queued" || job.status === "processing") ? <Spinner size="xs" /> : null}
                                  <Text textStyle="eyebrow" color={job?.status === "failed" ? "danger.fg" : job?.status === "completed" ? "success.fg" : "fg.subtle"}>{job?.status ?? "not requested"}</Text>
                                  {job?.status === "failed" && job.id ? <Button size="xs" variant="ghost" disabled={thumbnailControlsBusy} onClick={() => void retryThumbnail(item.clip.id, job)}><RefreshCw size={11} /> Retry</Button> : null}
                                </Flex>
                              </Flex>
                            );
                          })}
                        </Stack>
                      </>
                    ) : null}
                    {!thumbnailExtractionEnabled &&
                    Object.keys(thumbnailJobs).length > 0 ? (
                      <Stack
                        gap="0"
                        borderTopWidth="1px"
                        borderColor="border.subtle"
                      >
                        {eligible.map((item) => {
                          const job = thumbnailJobs[item.clip.id];
                          if (!job) return null;
                          return (
                            <Flex
                              key={item.clip.id}
                              justify="space-between"
                              align="center"
                              py="2"
                              borderBottomWidth="1px"
                              borderColor="border.subtle"
                              gap="3"
                            >
                              <Text fontSize="xs">{rowLabel(item.clip)}</Text>
                              <Text
                                textStyle="eyebrow"
                                color={
                                  job.status === "failed"
                                    ? "danger.fg"
                                    : job.status === "completed"
                                      ? "success.fg"
                                      : "fg.subtle"
                                }
                              >
                                saved · {job.status}
                              </Text>
                            </Flex>
                          );
                        })}
                      </Stack>
                    ) : null}
                  </Stack>
                )}
                  </Stack>
                ) : null}

                <Stack gap="4" layerStyle="well" p="4">
              <Flex align="center" gap="2">
                <Box textStyle="data" color="accent.fg">{thumbnailControl ? "04" : "03"}</Box>
                <Text textStyle="title" fontSize="sm">Workspace-local posting window</Text>
              </Flex>
              <Grid templateColumns={{ base: "1fr 1fr", lg: "repeat(5, minmax(0, 1fr))" }} gap="3">
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">Start date</Text>
                  <Input size="sm" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
                </Box>
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">Window opens</Text>
                  <Input size="sm" type="time" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
                </Box>
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">Window closes</Text>
                  <Input size="sm" type="time" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
                </Box>
                <Box>
                  <Text textStyle="eyebrow" color="fg.subtle" mb="1">Every (minutes)</Text>
                  <Input size="sm" type="number" min="5" max="1440" value={frequencyMinutes} onChange={(event) => setFrequencyMinutes(event.target.value)} />
                </Box>
                <Flex align="end">
                  <Button size="sm" variant="outline" w="full" disabled={!canSchedule || bulkBusy} onClick={() => void scheduleCampaign()}>
                    {bulkBusy ? <Spinner size="xs" /> : <CalendarRange size={13} />}
                    {bulkBusy
                      ? "Scheduling…"
                      : bulkResult?.counts.failed
                        ? `Retry ${bulkResult.counts.failed} failed`
                        : bulkResult
                          ? "Scheduled"
                          : `Schedule ${eligible.length}`}
                  </Button>
                </Flex>
              </Grid>
              <Flex align="center" gap="2" color="fg.subtle">
                <Clock3 size={12} />
                <Text fontSize="11px">Times are interpreted in {workspaceTimezone}. Nonexistent and ambiguous daylight-saving times fail per item.</Text>
              </Flex>
              {!bulkSchedulingEnabled ? <Text fontSize="xs" color="warning.fg">Bulk scheduling is not enabled for this workspace.</Text> : null}
              {bulkError ? <Text role="alert" fontSize="xs" color="danger.fg">{bulkError}</Text> : null}
              {bulkResult ? (
                <Stack gap="0" borderTopWidth="1px" borderColor="border.subtle">
                  <Flex justify="space-between" py="2.5" borderBottomWidth="1px" borderColor="border.subtle">
                    <Text textStyle="title" fontSize="sm">
                      {bulkResult.status === "completed"
                        ? "Campaign scheduled"
                        : bulkResult.status === "partial"
                          ? "Campaign partly scheduled"
                          : "Campaign needs attention"}
                    </Text>
                    <Text textStyle="data" fontSize="11px">{bulkResult.counts.scheduled} scheduled · {bulkResult.counts.failed} failed</Text>
                  </Flex>
                  {bulkResult.items.map((item) => (
                    <Flex key={item.itemKey} position="relative" justify="space-between" gap="3" ps="3" py="2.5" borderBottomWidth="1px" borderColor="border.subtle">
                      <Box position="absolute" insetInlineStart="0" top="0" bottom="0" w="3px" bg={item.status === "scheduled" ? "success.solid" : "danger.solid"} />
                      <Text fontSize="xs">{rowLabel(clips.find((clip) => clip.id === item.clipId) ?? { index: 0, title: null })}</Text>
                      <Text textStyle="eyebrow" color={item.status === "scheduled" ? "success.fg" : "danger.fg"}>
                        {publishingBulkItemLabel(item.status, item.errorCode)}
                      </Text>
                    </Flex>
                  ))}
                </Stack>
              ) : null}
                </Stack>
              </>
            ) : null}
          </>
        )}
      </Stack>
    </Box>
  );
}
